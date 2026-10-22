export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function num(v: string | undefined, fallback: number): number {
  const n = v === undefined ? NaN : Number(v);
  return Number.isFinite(n) ? n : fallback;
}

/** Pull the first JSON value out of a model reply (handles ```json fences and chatter). */
export function extractJson<T = unknown>(text: string): T {
  const cleaned = text.replace(/```json|```/gi, "").trim();
  const starts = ["[", "{"]
    .map((c) => cleaned.indexOf(c))
    .filter((i) => i >= 0);
  if (!starts.length) throw new Error("No JSON found in model reply");
  const start = Math.min(...starts);
  const open = cleaned[start];
  const close = open === "[" ? "]" : "}";
  const end = cleaned.lastIndexOf(close);
  if (end <= start) throw new Error("Unterminated JSON in model reply");
  return JSON.parse(cleaned.slice(start, end + 1)) as T;
}

export function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max) + "\n…[truncated]";
}

export class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}
