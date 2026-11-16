# AgentFlow

A multi-tenant, no-code AI agent builder and automation platform (SSUET Computer Engineering FYP, Batch 2023f).
Drag cards onto a canvas, connect them, configure a card when it needs special behaviour, press Run.

**Current stage:** HTML prototype (plain HTML + CSS + vanilla JS, zero-dependency Node server). After the design is
approved it migrates to React/Vite/React Flow + Flask/MySQL. See `docs/MIGRATION.md` (written in phase 11).
**Status:** Phase 1 of 11 done, waiting at the design checkpoint. See `docs/PROGRESS.md`.

## Run it

Requires Node 18+. The project path contains a space, so quote it in a terminal.

```powershell
cd "D:\FYP\Agent Flow"
npm install          # only needed for tests/screenshots (Playwright); the server itself has no dependencies
node server.js       # http://localhost:3000
```

- Data lives in `data/db.json` (created from `data/seed.json` on first start, backups in `data/backups/`).
  To reset to the demo data, stop the server and delete `data/db.json`.
- If you open `index.html` by double-click (no server), the pages fall back to **offline demo mode**: the same
  demo data kept in this browser's localStorage. The login page tells you which mode you are in.
- `PORT=4000 node server.js` changes the port. The server listens on 127.0.0.1 only unless `HOST` is set.

## Seed accounts

Password for **every** account: `AgentFlow#2026` (demo data only).

| Role | Email | Notes |
|---|---|---|
| Super Admin | super@agentflow.test | Sees every company |
| Company Admin | admin@brightloom.test | Brightloom Studio, Basic plan, 7 of 10 seats used |
| Employee | ana@brightloom.test | Brightloom; also omar@, lina@, raj@brightloom.test |
| Frozen employee | dev.frozen@brightloom.test | Cannot sign in, shows a clear message |
| Company Admin (frozen company) | admin@kestrel.test | Kestrel Freight is frozen; sam@ and noor@kestrel.test too |
| Individual (free) | solo@example.test | 100 credits/month, personal flows only |

Scripts: `npm test` (unit tests), `npm run test:coverage`, `npm run shots` (design screenshots into
`docs/screenshots/`), `npm run seed` (rebuild `data/seed.json` and `assets/js/fallback-seed.js`).

## Folder map

```
server.js                 zero-dependency server: pages + JSON API + data/db.json
server/                   store.js (atomic writes, rolling backups), security.js (scrypt, tokens, rate limit)
data/                     seed.json (committed), db.json + backups/ (runtime, git-ignored)
index.html register.html  login and free signup
super/ admin/ app/        role areas (app/flows.html exists; the rest arrive in phases 3-7)
assets/css/theme.css      "Signal Bench" design system (light + dark tokens)
assets/js/                auth.js tenancy.js (shared rules), db.js (only data access), ui.js (app shell),
                          pages/ (one controller per page), fallback-seed.js (generated)
scripts/                  build-seed.js, screenshots.js
tests/unit, tests/e2e     node:test unit tests, Playwright e2e (phase 11)
docs/                     BUILD_SPEC, PLAN, DESIGN, PROGRESS, screenshots (MIGRATION in phase 11)
design-reference/         the two proposal PDFs (read-only input)
```

## Known demo-stage limits

- The offline fallback (no server) uses PBKDF2 instead of scrypt and has no login rate limit; the server uses scrypt and rate-limits.
- Sidebar items for screens not built yet show a "Soon" tag; that tag disappears as phases land.
- The demo-account panel on the login page is removed before launch.
