# AgentFlow – Build Plan

Source documents: `design-reference/FYP proposal(Agent Flow).pdf` (SSUET proposal, Batch 2023f),
`design-reference/Planning Requirments.pdf` (12-phase planning), and `docs/BUILD_SPEC.md`.
**Where they disagree, BUILD_SPEC.md wins** (it extends the scope).

## Differences from the proposal

| # | Topic | Proposal / Planning PDF | BUILD_SPEC.md (what we build) |
|---|-------|-------------------------|-------------------------------|
| 1 | Roles | Two roles: Admin and Normal User | Four roles: Super Admin, Admin (company), Employee, Individual |
| 2 | Tenancy | Single-organisation system | Multi-tenant: one database, `tenant_id` on every tenant-owned record, enforced server-side |
| 3 | Commercial model | Not mentioned | Plans, seats (Basic = $100 / 10 accounts, extra seats per seat), invoices, payments, simulated checkout |
| 4 | Usage limits | Not mentioned | Credits per node run, plan limits, usage bar, runs blocked when credits run out |
| 5 | Account control | Not mentioned | Freeze/unfreeze users and companies, admin password reset, login device/browser tracking |
| 6 | Super admin | Not mentioned | Cross-company panel: tenants, plans, payments, global audit log, DB import/export |
| 7 | Collaboration | Not mentioned | Several employees co-edit one flow: presence, node locks, SSE + BroadcastChannel |
| 8 | Versioning | Not mentioned | Every saved change set becomes a version; restore creates a new version |
| 9 | Block library | 5 blocks: Start, Search the Internet, Write Email, Create Report, End | 12 blocks (adds Summarize, Translate, Condition, Loop, Timer/Cron, Research Bot, Python Code) behind a node registry; users can duplicate and customise a card |
| 10 | Custom code block | Optional; "safe execution approach"; subject to supervisor approval | Python Code node validates and stores code but never executes it |
| 11 | AI model | Real AI Model API integrated before mid-evaluation | `AIProvider` adapter with a fake implementation now; real provider swapped in after design approval |
| 12 | Other integrations | Web search and email via real services | `SearchProvider` and `MailProvider` adapters with fakes; `PaymentGateway` adapter (new) with fake checkout |
| 13 | Stack, this stage | React + Flask + MySQL from Phase 1 | Plain HTML/CSS/vanilla JS + zero-dependency Node server + `data/db.json` first; React/Vite/React Flow, Flask/SQLAlchemy/MySQL after the design is approved (see `MIGRATION.md`) |
| 14 | Storage | MySQL | `db.json` (atomic writes, rolling backups) with `localStorage` fallback and Export/Import JSON |
| 15 | Auth | Password protection, roles | scrypt hashes, server-side session tokens (HttpOnly cookie), role and tenant derived on the server, login rate limit. Flask-JWT-Extended comes at migration |
| 16 | Realtime | Not mentioned | Server-Sent Events now, Flask-SocketIO at migration |
| 17 | Flow export | Download as file, image or PDF | JSON, PNG and PDF export plus JSON import |
| 18 | Admin dashboard | Users, activity, flows, runs, AI service status | Same metrics, scoped: company admins see their company, super admin sees all companies |
| 19 | Phase order | 12 phases starting with React/Flask/MySQL setup | 11 phases starting with design system + shell + `db.js` + `server.js` + seed, with a design checkpoint after phase 1 |
| 20 | Team split | Four members by area | Built end to end by one lead engineer (the Claude agent) for this stage |
| 21 | Timeline | 40 weeks, Oct 2026 – Jul 2027 | Prototype stage compressed; the proposal's timeline is unchanged for the migration stage |
| 22 | Testing | "Complete system testing" | Unit tests (80%+ coverage on db/auth/tenancy/engine/versions/billing) and Playwright e2e, including direct-API tenant-isolation attacks |

Unchanged from the proposal: drag-and-drop canvas, connections with validation, save/load flows,
step-by-step execution with per-step results, prompt-to-flow generation, Condition paths,
multi-agent hand-off of outputs, run history and audit log, error handling with readable messages.

Not readable: the Gantt chart in the proposal (page 4/5) is an image; the text timeline on page 6/7 was used instead.

## Phase mapping to the planning PDF

| Planning PDF | This build |
|---|---|
| 1 Setup, 2 DB + auth, 3 Dashboard + UI | Phases 1, 2 |
| 4 Builder, 6 Engine | Phases 6, 7 |
| 5 Storage + AI | Phases 5, 7 (fake AI) |
| 7 Prompt generation, 8 Multi-agent + conditions | Phase 10 (Architect), Phase 7 (Condition/Loop) |
| 9 Security, history, custom code | Phases 2, 7, 11 |
| 10 Download + Admin dashboard | Phases 3, 4, 10 |
| 11 Integration + testing, 12 Docs | Phase 11 |

## Architecture

- `server.js` (zero dependency): static pages + JSON REST + SSE; `server/store.js` (atomic JSON
  store + backups), `server/security.js` (scrypt, tokens, rate limiter, cookies).
- Shared UMD modules used by both browser and server so rules live in one place:
  `assets/js/auth.js` (validation, roles, permissions, UA parsing, login eligibility),
  `assets/js/tenancy.js` (record scoping and access checks).
- `assets/js/db.js`: the only data access point for pages. Two backends with one interface:
  HTTP (`/api`) and Local (`localStorage` + embedded seed) chosen automatically.
- Adapters (`assets/js/adapters/{ai,search,mail,payment}.js`): interface + fake implementation.
- Pages never contain business logic; they call `AF.db`, `AF.auth`, `AF.ui`.

Known demo-only deviation: the browser-only fallback cannot run scrypt, so fallback seed
accounts use PBKDF2 (WebCrypto). The server always uses scrypt.

## Phases and tasks

1. **Design system, shell, login/register, db.js, server.js, seed** – theme.css, ui.js shell,
   index/register, `app/flows.html` (real list, proves the shell), store, auth endpoints, seed
   builder. *Checkpoint: screenshots light + dark, wait for approval.*
2. **Auth, roles, sessions, devices, tenancy** – permission matrix on every endpoint, devices and
   login events, freeze rules, password reset, tenant-isolation tests.
3. **Super admin pages** – dashboard, tenants, tenant-detail, payments, audit, import/export.
4. **Admin pages** – dashboard, employees (seat limit), billing (plan change, extra seats,
   simulated checkout, invoices), activity.
5. **Flows list, templates, account, credits** – CRUD, share in company, usage bar, limits.
6. **Builder canvas + node registry** – library, canvas, settings panel, undo/redo, shortcuts.
7. **Engine, runs, validation** – execution, Condition/Loop, per-step records, Stop, run history.
8. **Versions** – version per change set, history panel, restore.
9. **Co-work + locks** – SSE, BroadcastChannel, presence, node locks, per-node merge.
10. **AI Flow Architect, export/import, polish.**
11. **Hardening, docs, migration notes** – `/security-scan`, coverage, README, MIGRATION.md.

After each phase: `/code-review` (fresh context) → security-review → verification-loop (unit +
server + Playwright) → update `PROGRESS.md` → commit.

## Data model (`data/db.json` collections)

`tenant_id` is on every tenant-owned record; individuals have `tenant_id: null` and own their data via `owner_id`.

| Collection | Key fields |
|---|---|
| tenants | id, name, plan_id, status (active/frozen), frozen_reason, extra_seats, created_at |
| users | id, tenant_id, role (superadmin/admin/employee/individual), name, email, password_hash, status, prefs{theme}, created_at, created_by |
| sessions | id (sha-256 of token), user_id, tenant_id, role, device_id, ip, created_at, expires_at |
| devices | id, user_id, fingerprint, browser, os, device, first_seen, last_seen, login_count |
| loginEvents | id, user_id, tenant_id, at, ip, browser, os, device, success, reason |
| plans | id, name, price_usd, seats, credits_per_month, extra_seat_usd |
| subscriptions | id, tenant_id, plan_id, status, period_start, period_end, extra_seats |
| invoices | id, tenant_id, number, items[], amount_usd, status, issued_at, paid_at |
| payments | id, tenant_id, invoice_id, amount_usd, method, status, created_at |
| flows | id, tenant_id, owner_id, name, nodes[], edges[], version, shared, created_at, updated_at |
| flowVersions | id, flow_id, tenant_id, n, user_id, user_name, at, summary, snapshot |
| runs | id, flow_id, tenant_id, user_id, status, started_at, ended_at, credits, error |
| runSteps | id, run_id, tenant_id, node_id, type, status, ms, credits, input, output, error |
| templates | id, tenant_id (null = global), name, description, category, nodes[], edges[] |
| usage | id, tenant_id, user_id, period, credits_used, credits_limit |
| auditLog | id, tenant_id, actor_id, actor_name, action, target, at, meta |
| presence | flow_id, user_id, name, color, node_id, at |
| locks | flow_id, node_id, user_id, at, expires_at |

## API endpoints

Role and tenant always come from the session cookie, never from the request body or query.
`SA` super admin, `AD` admin, `EM` employee, `IN` individual.

| Phase | Method + path | Who | Notes |
|---|---|---|---|
| 1 | GET /api/health | public | liveness + mode |
| 1 | POST /api/auth/login | public | rate-limited; records device + login event; frozen → 403 |
| 1 | POST /api/auth/register | public | creates Individual, free plan credits |
| 1 | POST /api/auth/logout | any | destroys session |
| 1 | GET /api/auth/me | any | current user + tenant |
| 1 | PATCH /api/auth/prefs | any | theme |
| 1 | GET /api/flows | any | tenant-scoped (individual: own only; SA: all) |
| 2 | GET /api/users, POST /api/users, PATCH /api/users/:id, POST /api/users/:id/reset-password, POST /api/users/:id/freeze\|unfreeze | SA, AD | AD limited to own tenant and seat limit |
| 2 | GET /api/devices, GET /api/login-events | SA, AD | scoped |
| 3 | GET/POST/PATCH/DELETE /api/tenants[/:id], freeze/unfreeze, plan change | SA | |
| 3 | GET /api/payments, GET /api/invoices, GET /api/audit | SA all, AD own | |
| 3 | GET /api/db/export, POST /api/db/import | SA (AD: own tenant export/import) | |
| 4 | GET /api/billing, POST /api/billing/checkout, POST /api/billing/seats | AD | simulated gateway |
| 5 | POST/PATCH/DELETE /api/flows[/:id], POST /api/flows/:id/duplicate, share | all non-super | |
| 5 | GET /api/templates, POST /api/templates/:id/clone, GET /api/usage | all | |
| 7 | POST /api/flows/:id/runs, GET /api/runs[/:id] | EM, AD, IN | credits enforced |
| 8 | GET /api/flows/:id/versions, POST …/restore | members of the flow's tenant | |
| 9 | GET /api/flows/:id/events (SSE), POST …/presence, POST/DELETE …/locks | members | |

## Test plan

- **Unit (node:test, `node --test`)**: store, security, auth, tenancy, db (local backend), server
  HTTP integration, later engine, versions, billing. Target ≥ 80% line coverage on those modules
  (`node --test --experimental-test-coverage`).
- **TDD**: failing test first for every logic module; the red run is recorded in `PROGRESS.md`.
- **E2E (Playwright)**: login for 4 roles; tenant isolation via UI and direct API with another
  tenant's id; seat limit; freeze/unfreeze; build/save/reopen/run flow; version restore;
  co-editing in two browser contexts; credit exhaustion; export/import.
- **Security checks per phase**: output escaping (no `innerHTML` with data), unauthenticated and
  cross-tenant requests rejected, rate limit, input validation, path traversal on static server.
- **Manual**: light/dark screenshots, keyboard focus, reduced motion, 375px width.
