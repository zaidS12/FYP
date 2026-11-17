# Migration guide: HTML prototype to the real stack

Target stack: **React + Vite + React Flow** (front end), **Flask + SQLAlchemy** (API), **MySQL** (data), **Flask-JWT-Extended** (auth),
**Flask-SocketIO** (live co-work), **Docker Compose**. The prototype was written so each module maps to one place in the new stack.
Business rules live in plain functions (`server/services/*.js`, `assets/js/*.js` UMD modules) and are covered by unit tests, so the
Python port can reuse the test cases as a specification.

## 1. Module map

| Prototype | Role | Becomes |
|---|---|---|
| `server.js` (router, cookies, headers, SSE) | HTTP API, static pages | Flask app (blueprints per area), Nginx for static files |
| `server/security.js` | scrypt hashing, tokens, rate limiter, cookies | `werkzeug.security` or `argon2`, Flask-Limiter, Flask-JWT-Extended cookies |
| `server/store.js` (+ `data/db.json`, backups) | JSON file with atomic writes | SQLAlchemy models + Alembic migrations on MySQL; backups = `mysqldump` |
| `server/services/users.js` | accounts, seats, devices, login events | `services/users.py`, tables `users`, `devices`, `login_events` |
| `server/services/tenants.js`, `ledger.js`, `backup.js` | companies, invoices, audit, import/export | `services/tenants.py`, `billing.py`, `audit.py`; export/import as admin CLI + endpoints |
| `server/services/billing.js` + `server/adapters/payment.js` | seats, plans, invoices, simulated gateway | `PaymentGateway` interface; Stripe (or local gateway) implementation |
| `server/services/flows.js`, `merge.js` | flows, versions, restore, per-card merge | `services/flows.py`; `merge.py` is a direct port (pure function, tests port 1:1) |
| `server/services/runs.js`, `credits.js` | server-side runs, credits, Stop | Celery or RQ worker for runs; credits in a transaction (`SELECT ... FOR UPDATE`) |
| `server/services/collab.js` + SSE hub | presence and card locks | Flask-SocketIO rooms (`flow:<id>`) with Redis as message queue and lock store (TTL keys) |
| `server/services/impersonation.js`, `audit.js` | "Login as" | see section 3 |
| `assets/js/db.js` | the only data access module, HTTP + localStorage fallback | `src/api/client.ts` (fetch/axios + TanStack Query); the localStorage fallback is dropped |
| `assets/js/auth.js`, `tenancy.js` | roles, permissions, tenant scoping | `permissions.ts` (UI hints only) and `authz.py` (the real checks) |
| `assets/js/nodes.js` | card registry: `{id, category, fields, ports, summary}` | `nodes/registry.ts` (React Flow `nodeTypes`), forms generated from the same field schema; server keeps a JSON copy for validation |
| `assets/js/engine.js` | validation and the run loop | validation: shared TypeScript module + Python port; run loop: Python (`engine.py`) in the worker |
| `assets/js/canvas.js` | custom pan/zoom canvas | **React Flow**: nodes/edges state, `onConnect`, `onNodesChange`, MiniMap, Controls. Undo/redo with a history store; `layoutFlow` becomes dagre/elk |
| `assets/js/collab.js` | SSE client + polling fallback + BroadcastChannel | `socket.io-client` (it has its own reconnect/polling fallback); keep BroadcastChannel for same-browser tabs |
| `assets/js/exporter.js` | JSON/PNG/PDF export, import parser | JSON: same format (`agentflow.flow`, version 1). PNG: `html-to-image` or React Flow's `getViewportForBounds`. PDF: `pdf-lib` or server-side WeasyPrint |
| `assets/js/architect.js` + `adapters/ai.js` | rule-based "AI Flow Architect" | `AIProvider.plan_flow()` calls a real model with a JSON schema (cards from the registry); the response shape `{name, steps, links, notes}` stays |
| `assets/js/adapters/{search,mail}.js` | fake search and mail | `SearchProvider` (SerpAPI/Brave), `MailProvider` (SMTP/SES) |
| `assets/js/pages/*.js`, `ui.js`, `ui-kit.js` | page controllers, shell, dialogs | React routes/components; `theme.css` variables become CSS variables or Tailwind tokens (no redesign needed) |

## 2. Data model (MySQL)

One database, `tenant_id` on every tenant-owned table, indexed. Names match the JSON collections:
`tenants, users, sessions (JWT jti blocklist), devices, login_events, plans, subscriptions, invoices, payments, flows, flow_versions,
runs, run_steps, templates, usage (credits), audit_log`. `presence` and `locks` are **not** tables: they live in Redis with TTL
(`presence:<flow>:<client>`, `lock:<flow>:<node>`), exactly as `collab.js` keeps them in memory today.

Notes for the port:

- `flows.nodes` / `flows.edges` and `flow_versions.snapshot` become `JSON` columns. Keep `version` as an integer and keep the
  `base_version` compare-and-save (`UPDATE flows SET ... WHERE id=? AND version=?`).
- Ids are random strings (`f_ab12...`); keep them as `CHAR(20)` or switch to UUIDv7 and map in the importer.
- `runs`/`run_steps` grow without bound: partition by month or prune (the prototype keeps the newest 500 runs per company).
- Passwords: scrypt hashes can be imported as they are if Python uses the same parameters (`N=16384, r=8, p=1`, format `scrypt$N$r$p$salt$hash`).
  Otherwise rehash on first login.

## 3. Impersonation ("Login as") with JWT

Prototype: the server session row holds `user_id` (the **real** person) and `subject_id` plus `imp_expires_at`; every request re-runs
`canImpersonate(real, subject)`; permissions come from the subject; audit rows record `actor` and `acting_as`.

Flask-JWT-Extended mapping:

1. Normal login issues an access token with `sub = user id`, `role`, `tenant_id`.
2. `POST /api/impersonation/start {user_id}` (needs a normal token, refused if the token already has an `act` claim) issues a **new, short-lived
   access token (<= 30 min, no refresh token)**:
   ```json
   { "sub": "<subject id>", "role": "<subject role>", "tenant_id": "<subject tenant>",
     "act": { "sub": "<actor id>", "role": "<actor role>" },
     "imp": true, "exp": "<now + 30 min>", "jti": "..." }
   ```
   (`act` is the RFC 8693 "actor" claim.) The browser keeps the actor's own token aside so "Return to my account" simply restores it.
3. A `@jwt.additional_claims_loader` / `token_in_blocklist_loader` pair makes the check **per request**, not only at start:
   load the actor and the subject from the database, call the same `can_impersonate(actor, subject)` rules, and reject
   (401, revert) if the subject is now frozen, moved company, deleted, or the actor lost the right. Revoking = adding the `jti` to the blocklist,
   which also covers logout and "Return".
4. Authorization uses the token's top-level claims (the subject). `audit.record()` reads `act` and writes `"<actor> acting as <subject>"`;
   versions and runs get `by_id`/`by_name` from `act`.
5. Keep the same guards: no chaining (reject start when `act` is present), no super-admin subject, admin only for own-company active employees,
   subject password/email/saved cards untouched, theme not persisted, device and sign-in lists untouched (separate `impersonation.*` audit rows).
6. Co-work: presence and lock owner is `act.sub` (the real person) labelled "Actor (as Subject)"; the lock owner key stays `client_id`,
   bound to the person at first use (`collab.claim`). Port that binding to the Socket.IO connection (the authenticated user id is attached
   to the socket session at connect time).

## 4. Real-time (SSE to Socket.IO)

| Prototype | Flask-SocketIO |
|---|---|
| `GET /api/flows/:id/events` (SSE), server re-checks access every 5 s | namespace `/flows`, `join_room('flow:<id>')` after an access check; re-check on every `lock`/`save` event and on a timer |
| events `collab` (snapshot) and `version` | same two event names; payloads unchanged |
| `POST /collab/heartbeat|lock|unlock|leave` | socket events with acks; heartbeat = Socket.IO ping + `presence` TTL refresh |
| polling fallback `GET /collab` | not needed (Socket.IO long-polling), keep the GET for debugging |
| `PATCH /api/flows/:id` lock enforcement + merge | unchanged: keep in the HTTP save endpoint, because locks are advisory UI but enforced on save |

## 5. Simulated parts and how each is replaced

| Simulated now | Interface to keep | Replace with |
|---|---|---|
| AI calls (summarize, translate, email text, report, research) | `AIProvider` methods in `adapters/ai.js` | LLM API behind the same methods; token counts feed `credits` |
| AI Flow Architect | `AIProvider.planFlow({prompt})` | LLM with a JSON schema of the card registry, validated by `engine.validateFlow` before it reaches the canvas |
| Web search | `SearchProvider.search()` | Search API |
| Email sending | `MailProvider.send()` | SMTP/SES with bounce handling |
| Payments | `PaymentGateway` (`charge`) | Stripe Checkout/PaymentIntents; webhooks mark invoices paid |
| Python Code card | validate and store only | sandboxed runner (container with no network, CPU/memory limits) before enabling execution |
| Timer / Cron card | runs once when you press Run | Celery beat / APScheduler reading the flow's schedule |
| Presence/locks in memory | `Collab` class | Redis TTL keys |

## 6. "Remove before deployment" (also in README.md)

Demo accounts and the demo-password panel on the login page, the `BUILT` list in `ui.js`, auto-fill helpers, the `[ai-error]` demo trigger,
`TRUST_PROXY` defaults, the offline localStorage backend in `db.js`, and `data/seed.json` as a production seed.

## 7. Suggested order of work

1. Database schema + Alembic + seed importer (`data/seed.json` is already in the target shape).
2. Auth (login, JWT, devices, freeze), tenancy middleware, audit; port `users`, `tenants`, `billing` services with their unit tests.
3. Flows, versions, merge, restore; then runs + credits + worker.
4. React app: shell and pages first (reuse copy and states from the HTML pages), then the builder on React Flow.
5. Socket.IO co-work and impersonation tokens; then real providers (AI, search, mail, payment).
6. Port the Playwright suite as-is: it drives the UI and HTTP API, so it validates the new stack with only URL and seed changes.
