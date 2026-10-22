import "dotenv/config";
import express, { type NextFunction, type Request, type Response } from "express";
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { loadConnectors } from "./connectors/index.js";
import { loadPolicy } from "./policy.js";
import { Engine } from "./engine.js";
import { FileStore, PgStore, type Store } from "./store.js";
import { HttpError } from "./util.js";

// ---------- config ----------
const PORT = Number(process.env.PORT ?? 3000);
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD ?? "";
if (ADMIN_PASSWORD.length < 8) {
  console.error("Set ADMIN_PASSWORD (at least 8 characters) in your environment or .env file.");
  process.exit(1);
}
const SECRET = process.env.SESSION_SECRET || createHash("sha256").update("jarvis:" + ADMIN_PASSWORD).digest("hex");
const COOKIE = "jv_session";
const SESSION_MS = 7 * 24 * 3600 * 1000;

let connectors = loadConnectors(process.env.USE_MOCK === "1");
const usingMock = process.env.USE_MOCK === "1" || connectors.length === 0;
if (connectors.length === 0) {
  console.log("No API keys found: starting with offline demo agents. Add keys in .env for real AIs.");
  connectors = loadConnectors(true);
}

const store: Store = process.env.DATABASE_URL ? new PgStore(process.env.DATABASE_URL) : new FileStore();
await store.init();
const engine = new Engine(store, connectors, loadPolicy(), usingMock);
await engine.recover();

// ---------- auth ----------
const sign = (v: string) => createHmac("sha256", SECRET).update(v).digest("hex");
const safeEq = (a: string, b: string) => {
  const x = createHash("sha256").update(a).digest();
  const y = createHash("sha256").update(b).digest();
  return timingSafeEqual(x, y);
};
function makeToken() {
  const exp = String(Date.now() + SESSION_MS);
  return `${exp}.${sign(exp)}`;
}
function validToken(t: string | undefined) {
  if (!t) return false;
  const [exp, sig] = t.split(".");
  if (!exp || !sig || !(Number(exp) > Date.now())) return false;
  const a = Buffer.from(sig);
  const b = Buffer.from(sign(exp));
  return a.length === b.length && timingSafeEqual(a, b);
}
function cookieOf(req: Request, name: string) {
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
  return undefined;
}
const attempts = new Map<string, { n: number; reset: number }>();

// ---------- app ----------
const app = express();
app.set("trust proxy", 1);
app.disable("x-powered-by");
app.use(express.json({ limit: "20kb" }));
app.use((_req, res, next) => {
  res.setHeader("Content-Security-Policy", "default-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  next();
});
app.use(express.static(join(dirname(fileURLToPath(import.meta.url)), "..", "public")));

const api = express.Router();
api.use((_req, res, next) => {
  res.setHeader("Cache-Control", "no-store");
  next();
});

api.get("/health", (_req, res) => res.json({ ok: true }));

api.post("/login", (req, res) => {
  const ip = req.ip ?? "unknown";
  const now = Date.now();
  const a = attempts.get(ip);
  if (a && a.reset > now && a.n >= 10) throw new HttpError(429, "Too many attempts. Try again in a few minutes.");
  const password = typeof req.body?.password === "string" ? req.body.password : "";
  if (!safeEq(password, ADMIN_PASSWORD)) {
    attempts.set(ip, a && a.reset > now ? { n: a.n + 1, reset: a.reset } : { n: 1, reset: now + 15 * 60 * 1000 });
    throw new HttpError(401, "Wrong password.");
  }
  attempts.delete(ip);
  res.cookie(COOKIE, makeToken(), { httpOnly: true, sameSite: "strict", secure: req.secure, maxAge: SESSION_MS, path: "/" });
  res.json({ ok: true });
});

api.post("/logout", (_req, res) => {
  res.clearCookie(COOKIE, { path: "/" });
  res.json({ ok: true });
});

// everything below needs a valid session
api.use((req, _res, next) => {
  if (!validToken(cookieOf(req, COOKIE))) return next(new HttpError(401, "Log in first."));
  next();
});

const UUID = /^[0-9a-f-]{36}$/i;
const idOf = (req: Request) => {
  const id = String(req.params.id);
  if (!UUID.test(id)) throw new HttpError(400, "Bad job id.");
  return id;
};
const approveFlag = (req: Request) => {
  if (typeof req.body?.approve !== "boolean") throw new HttpError(400, "Send { approve: true | false }.");
  return req.body.approve as boolean;
};
const wrap = (fn: (req: Request, res: Response) => Promise<unknown>) => (req: Request, res: Response, next: NextFunction) =>
  fn(req, res).catch(next);

api.get("/status", (_req, res) => res.json({ agents: engine.agents, mock: engine.usingMock, capUsd: engine.capUsd }));
api.get("/jobs", wrap(async (_req, res) => void res.json(await engine.list())));
api.post("/jobs", wrap(async (req, res) => {
  const goal = typeof req.body?.goal === "string" ? req.body.goal : "";
  res.status(201).json(await engine.createJob(goal));
}));
api.get("/jobs/:id", wrap(async (req, res) => void res.json(await engine.get(idOf(req)))));
api.post("/jobs/:id/plan", wrap(async (req, res) => void res.json(await engine.decidePlan(idOf(req), approveFlag(req)))));
api.post("/jobs/:id/step", wrap(async (req, res) => void res.json(await engine.decideStep(idOf(req), approveFlag(req)))));
api.get("/jobs/:id/report", wrap(async (req, res) => {
  const job = await engine.get(idOf(req));
  if (!job.report) throw new HttpError(404, "The report is not ready yet.");
  res.setHeader("Content-Type", "text/markdown; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="jarvis-report-${job.id.slice(0, 8)}.md"`);
  res.send(job.report);
}));

app.use("/api", api);
app.use("/api", (_req, _res, next) => next(new HttpError(404, "Not found.")));

app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  if (err instanceof HttpError) return void res.status(err.status).json({ error: err.message });
  if (err instanceof SyntaxError) return void res.status(400).json({ error: "Invalid JSON." });
  const ref = randomBytes(4).toString("hex");
  console.error(`[${ref}]`, err);
  res.status(500).json({ error: `Something went wrong on the server (ref ${ref}).` });
});

app.listen(PORT, () => {
  console.log(`Jarvis is running on http://localhost:${PORT}`);
  console.log(`Agents: ${engine.agents.join(", ")}${usingMock ? " (offline demo agents)" : ""}`);
  console.log(`Storage: ${process.env.DATABASE_URL ? "Postgres" : "local files in ./data"}`);
});
