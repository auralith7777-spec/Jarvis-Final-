# Jarvis (v0.2): web service + dashboard

Connect several AIs, plan a goal, cross-check the risky steps, ask before consequential actions,
cap spend, and keep an audit trail. v0.1 was the CLI core; v0.2 wraps it in a live service with a dashboard.

## Run locally (Windows PowerShell)

```powershell
npm install
copy .env.example .env     # set ADMIN_PASSWORD; add API keys if you have them
npm start                  # open http://localhost:3000
```
No keys? It starts with offline demo agents so you can see the whole flow.

CLI still works: `npm run demo` or `npm run jarvis -- "your goal"`.

## Deploy on Render
1. Push this folder to a new GitHub repo (separate from Arvo).
2. Render: New > PostgreSQL. Copy its **Internal Database URL**.
3. Render: New > Web Service from the repo.
   - Build command: `npm install`
   - Start command: `npm start`
4. Environment variables: `ADMIN_PASSWORD` (long!), `DATABASE_URL` (the internal URL), plus any API keys and model names.
5. Open the service URL, sign in, run a job. Check Render's current free-tier limits before relying on it.

## How a job flows
goal → **plan** (you approve) → each step runs → risky steps are **cross-checked** by 2-3 agents and a judge →
steps matching `policy.json` **ask before running** → **report** with provenance, cost and flagged items.
Everything is logged in the job's activity log. Jobs wait for your approval across server restarts.

## Files
| Path | Job |
|---|---|
| `src/server.ts` | Express API, login, security headers |
| `src/engine.ts` | Job state machine (pause for approval, resume, spend cap) |
| `src/store.ts` | Postgres (production) or local JSON files (dev) |
| `public/*` | Dashboard (plain HTML/CSS/JS, no build step) |
| `src/connectors/*` | One adapter per AI. New agent = one file + one line in `index.ts` |
| `src/planner.ts, router.ts, crosscheck.ts, policy.ts, cost.ts, audit.ts` | The brain (from v0.1) |
| `policy.json` | Spend cap, words that need approval, words that are blocked |

## Known limits
- Model names and prices are placeholders. Set the current ones in `.env`.
- Steps only generate text. "Send email" is gated by approval but sends nothing yet.
- The judge compares answers; it can't check facts on the web yet.
- Single admin password, one user. No team accounts yet.
- Web version has no screen capture. The header says so on purpose.
- Tested: API flow, restart recovery, and the dashboard in a real browser (with demo agents). Not tested: real AI APIs, real Postgres.
