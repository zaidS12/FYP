# AgentFlow – Progress Log

Resume in a new chat by reading `docs/BUILD_SPEC.md` (the full brief), `docs/PLAN.md` and this file.

## Phase 0 – Part A: ECC install — DONE (2026-11-17)
- Prereqs: node v24.19.0, git 2.55.0, npm 11.17.0. No prior ECC install; cloned official
  `affaan-m/ECC` (v2.2.3) to `D:\FYP\_tools\ECC` and ran `.\install.ps1 --profile full --target claude --enable-hooks`.
- `doctor`: OK, 0 warnings, 0 errors. 8 required skills present, 76 agents. Rules `common` + `typescript` in `.claude/rules/ecc/`.
- The first install run reported a non-zero exit code. Cause: my own `Select-Object -First 15` closed the pipe early.
  Re-run unpiped: exit 0, 1265 operations applied. No operation failed.
- Hooks (standard profile) include GateGuard fact-forcing on PowerShell/Edit/Write, which asks for facts before first
  writes and commands. Batch work to limit interruptions.

## Phase 1 – design system, shell, login/register, db.js, server.js, seed — DONE, AWAITING DESIGN APPROVAL
- `docs/PLAN.md` (22 differences from the proposal, phases, data model, API, tests) and `docs/DESIGN.md` ("Signal Bench") written.
- PDFs were found on the Desktop (`Desktop\fyp\`) and copied into `design-reference/`.
- Built: `server.js`, `server/store.js`, `server/security.js`, `assets/js/{auth,tenancy,db,ui}.js`, `assets/js/pages/*`,
  `assets/css/theme.css`, `index.html`, `register.html`, `app/flows.html`, `scripts/build-seed.js`, `scripts/screenshots.js`.
- TDD: tests written first; red run = all 6 suites failing on missing modules. Now 55 tests, all green.
  Coverage: auth 99%, tenancy 98%, security 97%, store 100%, server 97%, db 77.5% (browser HTTP backend and `init()`
  are only reachable from a browser; covered by Playwright e2e in phase 11).
- Independent code + security review (fresh context): no critical/high findings. Fixed: login rate-limit bypass by
  interleaving successful logins (IP and per-email failure budgets are never reset by success), limiter memory growth,
  login-event cap, `Secure` cookie + HSTS behind a proxy, equalised bad-password vs unknown-email timing (deferred save),
  rightmost `X-Forwarded-For`, non-object JSON bodies (400 not 500), static stream error handler, 413 delivery, corrupt DB
  kept aside as `db.json.corrupt-*`, missing collections defaulted, and **private flows are now hidden from colleagues**
  (visible to owner, company admin, super admin).
- Verified on the real server: starts clean, creates `data/db.json`, registered user survives kill + restart, `/data/db.json`
  and `/server.js` return 404.
- Screenshots (light, dark, mobile) in `docs/screenshots/`. Dark mode toggle persists per user (scripted check).
- Design hook: `side-tab` finding on the node tag's category spine suppressed per file (intentional signature element,
  recorded in `.impeccable/config.json`). `overused-font` (Instrument Sans) left standing, pending the user's call.

## Known gaps carried forward
- Sidebar items for unbuilt pages show "Soon"; `New flow` button is disabled until phase 5. Remove `BUILT` in `ui.js` in phase 11.
- Demo-account panel on the login page: remove before launch.
- Offline fallback (no server) uses PBKDF2 and has no login rate limit (demo-only, documented).
- Not done yet from the review (low value at this stage): debounce/batch of `db.json` writes under heavy load.

## Next steps
1. User reviews `docs/screenshots/` and approves or requests theme changes (design checkpoint).
2. Phase 2: permission matrix on every endpoint, user management, devices and login-event views, freeze rules, reset password, tenant-isolation tests.
