# AgentFlow

A multi-tenant, no-code AI agent builder and automation platform (SSUET Computer Engineering FYP, Batch 2023f).
Drag cards onto a canvas, connect them, configure a card when it needs special behaviour, press Run.

**Stage:** finished HTML prototype (plain HTML + CSS + vanilla JS, zero-dependency Node server, data in a JSON file).
After design approval it migrates to React/Vite/React Flow + Flask/MySQL, see [docs/MIGRATION.md](docs/MIGRATION.md).
Progress log: [docs/PROGRESS.md](docs/PROGRESS.md). The full brief: [docs/BUILD_SPEC.md](docs/BUILD_SPEC.md).

## What works

- **Four roles:** Super Admin (every company), Company Admin (own company, seats, billing, activity), Employee, Individual (free plan).
  Tenant isolation is enforced on the server for every endpoint, not only in the pages.
- **"Login as":** a Super Admin can open any admin or employee account, an Admin any active employee of their own company.
  A banner shows who is acting as whom, every action is audited as "actor acting as subject", passwords are never revealed or changeable.
- **Builder:** 12 cards, drag/connect, undo/redo, auto-align, validation shown on the cards, run with live results and Stop, credits enforced on the server.
- **Versions:** every save is a version with author, time and a plain-language summary; one-click restore creates a new version.
- **Co-work:** several people edit one flow: presence avatars, who is on which card, card locks, per-card merge of simultaneous saves
  (Server-Sent Events with a polling fallback, BroadcastChannel between tabs of one browser).
- **AI Flow Architect:** type "Find daily AI news and email me a summary" and get an editable flow (simulated, see below).
- **Export / import:** JSON (importable), PNG picture, PDF document.
- **Billing:** plans, extra seats, simulated card checkout, invoices, overdue handling, company freeze.
- Light and dark themes, keyboard operable, reduced motion respected.

## Run it on your own computer (no online service needed)

Double-click **`start-agentflow.bat`** (Windows). It starts the server and opens http://localhost:3000 in your browser. Everything runs on your
computer; data is kept in `data/db.json` (with automatic backups in `data/backups/`) and is still there after you close the window and start it again.
You only need Node.js (LTS) installed. Close the window to stop the app. To let other people on the same Wi-Fi use it, run
`set HOST=0.0.0.0` before `node server.js` and share `http://<your-ip>:3000` (use only on a network you trust; the demo password is public).

## Run it (command line)

Requires Node 18+. The project path contains a space, so quote it in a terminal.

```powershell
cd "D:\FYP\Agent Flow"
npm install          # only needed for tests and screenshots (Playwright); the server itself has no dependencies
node server.js       # http://localhost:3000
```

- Data lives in `data/db.json` (created from `data/seed.json` on first start, rolling backups in `data/backups/`).
  To reset to the demo data, stop the server and delete `data/db.json`.
- Writes are batched (about 250 ms) for progress data and flushed on Ctrl+C / shutdown; changes a person waits for are written immediately.
- Old runs are trimmed automatically (newest 50 per company always kept, then 90 days / 500 per company; see `server/services/retention.js`).
- Opening `index.html` by double-click (no server) gives a limited **offline demo mode** (sign-in and the flows list only).
- `PORT=4000 node server.js` changes the port. The server listens on 127.0.0.1 only unless `HOST` is set.
  `TRUST_PROXY=1` only behind exactly one trusted reverse proxy.

## Seed accounts

Password for **every** account: `AgentFlow#2026` (demo data only).

| Role | Email | Notes |
|---|---|---|
| Super Admin | super@agentflow.test | Sees every company, can "Login as" any admin or employee |
| Company Admin | admin@brightloom.test | Brightloom Studio, Basic plan, 6 of 10 seats used |
| Employee | ana@brightloom.test | Brightloom; also omar@, lina@, raj@brightloom.test |
| Frozen employee | dev.frozen@brightloom.test | Cannot sign in, shows a clear message |
| Company Admin (frozen company) | admin@kestrel.test | Kestrel Freight is frozen; sam@ and noor@kestrel.test too |
| Individual (free) | solo@example.test | 100 credits/month, personal flows only |

Demo checkout card: `4242 4242 4242 4242`, any future date, any 3 digits (`4000 0000 0000 0002` is declined, `4000 0000 0000 9995` has no funds).
Demo failure for a run: put `[ai-error]` in a card's input text.

## Scripts

| Command | What it does |
|---|---|
| `npm test` | unit tests (`node:test`), `npm run test:coverage` adds coverage |
| `npm run test:e2e` | Playwright end-to-end tests against a throwaway data folder on port 3100 |
| `npm run shots` | design screenshots into `docs/screenshots/` |
| `npm run seed` | rebuild `data/seed.json` and `assets/js/fallback-seed.js` |

## Simulated now, real later

| Part | Today | Replaced by (see MIGRATION.md) |
|---|---|---|
| AI calls and the AI Flow Architect | `FakeAIProvider`, rule based and deterministic | an LLM behind the same `AIProvider` methods |
| Web search, email sending | `FakeSearchProvider`, `FakeMailProvider` | real search API, SMTP/SES |
| Payments | `FakeGateway` (nothing touches a bank) | Stripe or similar behind `charge()` |
| Python Code card | saved and checked, never executed | sandboxed runner |
| Timer / Cron card | runs once when you press Run | scheduler |
| Presence and locks | in server memory | Redis |

## Folder map

```
server.js                 zero-dependency server: pages + JSON API + SSE + data/db.json
server/                   store.js (atomic, batched writes, backups), security.js (scrypt, tokens, rate limit),
  services/               users tenants billing ledger backup flows runs credits account impersonation audit
                          merge collab retention (business rules, pure functions over the db object)
  adapters/               payment.js (fake gateway)
data/                     seed.json (committed), db.json + backups/ (runtime, git-ignored)
index.html register.html  login and free signup
super/ admin/ app/        role areas (16 pages in total)
assets/css/theme.css      "Signal Bench" design system (light + dark tokens)
assets/js/                auth tenancy (shared rules), db.js (the only data access), ui.js ui-kit.js (shell, dialogs),
                          nodes.js engine.js canvas.js (builder core), versions.js collab.js architect.js exporter.js,
                          adapters/ (ai search mail), pages/ (one controller per page)
scripts/                  build-seed.js, screenshots.js
tests/unit, tests/e2e     node:test unit tests, Playwright e2e
docs/                     BUILD_SPEC PLAN DESIGN PROGRESS MIGRATION, screenshots/
design-reference/         the two proposal PDFs (read-only input)
```

## Remove before deployment

- [ ] **Demo-account panel** on `index.html` and its auto-fill code in `assets/js/pages/login.js` (the `accounts` list and `demo-list`).
- [ ] **Demo password text** (`AgentFlow#2026`) shown on the login page and in this README.
- [ ] **Seed accounts**: delete `data/seed.json` users or replace them, delete `data/db.json`, and regenerate `assets/js/fallback-seed.js` (or stop shipping it).
- [ ] **Offline demo mode**: remove `assets/js/fallback-seed.js` and the local backend in `assets/js/db.js` (PBKDF2, no login rate limit, no server-side checks).
- [ ] **Demo card hint** in `assets/js/pages/admin-billing.js` (`CARD_HINT`) and the fake gateway `server/adapters/payment.js` (swap in the real gateway behind the same `charge` method).
- [ ] **`[ai-error]` failure trigger** in `assets/js/adapters/ai.js` (`_guard`).
- [ ] Set `NODE_ENV=production` (adds the `Secure` cookie flag and HSTS) and serve over HTTPS; set `TRUST_PROXY=1` only behind one trusted proxy.
- [ ] `scripts/build-seed.js` and `scripts/screenshots.js` are development tools, not for the deployed image.

## Deploy for free, data kept across restarts

The app is one long-running Node process, so use a host that runs Node (Render, Railway, Koyeb, Fly...). Vercel's serverless functions do not fit
(no live connections, no memory between requests). Free hosts have no persistent disk, so the server can copy its database to a **free Supabase
project** and restore it on every start. Nothing else changes.

1. **Supabase** (free): create a project, then in *SQL editor* run:
   ```sql
   create table agentflow_state (id text primary key, data jsonb not null, updated_at timestamptz default now());
   alter table agentflow_state enable row level security;   -- no policies: only the secret service key can read/write
   ```
   Copy the *Project URL* and the **service_role** key (Settings > API). The table URL is `<Project URL>/rest/v1/agentflow_state`.
2. **Render** (free): New > Blueprint > pick this repository (reads `render.yaml`). In the dashboard set the two secret variables
   `REMOTE_STORE_URL` (the table URL above) and `REMOTE_STORE_KEY` (the service_role key). Everything else is in `render.yaml`.
3. First start: the table is empty, so the app starts from the demo seed and uploads it. After that every restart restores the latest data.
   If Supabase cannot be read (wrong key, outage) the server **refuses to start** instead of starting empty and overwriting your data.

Notes: free Render sleeps after ~15 minutes without visitors (the first visit then takes about a minute); a free uptime pinger such as UptimeRobot hitting
`/api/health` every 5 minutes keeps it awake. Changes are uploaded about 2 seconds after they happen and on shutdown, so a hard crash can lose the last
couple of seconds. The service_role key is a secret: keep it in environment variables only. The demo accounts and password are public in this repository,
so treat a deployed demo as public too (`ALLOW_FAKE_GATEWAY=1` lets the fake payment gateway run in production for the demo).
Other hosts: use the same environment variables as in `render.yaml` (`NODE_ENV`, `HOST=0.0.0.0`, `TRUST_PROXY=1`, `DATA_DIR`, `REMOTE_STORE_*`, `ALLOW_FAKE_GATEWAY`).

## Deploy on Vercel (free, no card)

Vercel runs code only while a request is being answered, so the repository contains a serverless adapter (`api/index.js`, `server/serverless.js`,
`vercel.json`). It needs the same free Supabase table as above and two environment variables in the Vercel project: `REMOTE_STORE_URL` and
`REMOTE_STORE_KEY`. How it behaves differently from the normal server:

- the whole database is loaded from Supabase and **every change is stored before the answer is sent**, so nothing is lost when Vercel freezes the function;
- before each request a tiny check reloads the data if another function instance changed it;
- a Run finishes inside its request (Stop is not useful there), and live streams are replaced by polling every few seconds;
- two changes at exactly the same moment on different instances can overwrite each other, and presence/lock information is per instance, so co-work
  is less precise than on the normal server. Use `start-agentflow.bat` or a normal Node host when exact live co-work matters.

## Known limits of the prototype

- Single Node process and one JSON file: fine for a demo, not for many concurrent companies (MySQL in the real stack).
- Presence, locks and SSE connections live in memory and reset on restart.
- Invoice numbers are max+1 (reused if the newest invoice is deleted); checkout has no idempotency key (the button disables while submitting).
- Undo history restarts when a colleague's save is merged into your canvas.
- No email verification or password-reset-by-email (an admin resets passwords).
- Exported JSON contains every card setting (email addresses, Python code).
