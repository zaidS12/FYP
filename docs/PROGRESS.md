# AgentFlow – Progress Log

Resume in a new chat by reading `docs/BUILD_SPEC.md` (the full brief), `docs/PLAN.md` and this file.
**No git commits until the owner says so** (owner rule, 2026-11-17). Phase 1 commit 781ce35 is untouched.

## OWNER DECISIONS (2nd round, override BUILD_SPEC)
"Login as" replaces "super admin cannot see/run flows". Work continuously through phases 8-11, one final report. No git writes. Copy the project to
`D:\FYP\_backups\agentflow-phase-<N>` (no node_modules) after each phase.

## Housekeeping + "Login as" (impersonation) + Phase 8 versions — DONE
- Baseline before changes: 215 unit, 61 e2e green. Canvas changes (fit minimum 85%, separate "Fit all", collapsible library, flat library cards) were already in.
- Screenshots now include a finished run (`builder-run-finished-light.png`), run history and a FAILED run's details (`runs-history-light.png`, `run-details-light.png`).
- Impersonation: `server/services/impersonation.js` (permission matrix, per-request `resolve`, 30 min expiry, begin/end audit with ip/browser/os/device),
  `audit.js` (one writer: "<actor> acting as <subject>", `by_id/by_name` on versions and runs), session keeps real user in `user_id` and `subject_id`.
  Super admin -> any admin/employee (frozen allowed, flagged); admin -> active employees of own company only; no chaining, no super admin subject.
  Subject password/email/name/saved cards are protected; theme is not persisted; devices and sign-ins untouched ("access" list in my activity).
  UI: persistent banner with "Return to my account", "Login as" buttons in the accounts table (tenant detail, employees).
- Independent review: no escalation found; fixed 4 items (company import attribution, saved cards and profile locked while impersonating, end-audit when the subject was deleted).
- Phase 8: `listVersions/getVersion/restoreVersion` (append-only, `base_version` required, refuses identical content, audited), History panel in the builder
  (`pages/builder-history.js`), attribution "Root (as Ana)".
- Tests: 244 unit; e2e impersonation (4) and versions (3) pass.

## Phase 9 – co-work — DONE
- `server/services/collab.js` (presence + card locks in memory with TTL, client ids bound to the first person who uses them), `merge.js` (three-way per-card merge:
  different cards merge, same card clashes with the card named; id clashes renamed; duplicate wire ids fixed; merge result re-validated), SSE hub in `server.js`
  (`/api/flows/:id/events`, access re-checked every 5 s, per-flow and per-user caps, closed on shutdown), `assets/js/collab.js` (SSE, polling fallback, BroadcastChannel,
  serialised lock requests), builder avatars, locked-card notes, remote-save notices; saves touching a locked card (cards OR their connections) are refused with 423.
- Impersonation: the lock owner is the real person labelled "Actor (as Subject)" and also blocks the subject's own tab.
- Independent review (included canvas.js and engine.js): no critical findings; fixed 2 high (duplicate edge ids after merge, merged save racing with new edits),
  5 medium (lock bypass via connections/align, client-id spoofing, lock leak before access check, merge result validation, same-id concurrent adds, stranded lock on fast clicks),
  low (empty maps, per-user stream cap, key-order compare). Accepted: a drag in progress while a colleague's save swaps the graph is dropped; undo history restarts on a merge.

## Phase 10 – AI Flow Architect, export/import, polish — DONE
- `assets/js/architect.js` + `AIProvider.planFlow` (rule-based, deterministic: fetch -> transform -> output order, schedule, language, e-mail address, condition),
  prompt bar in the builder (one undo step, confirm before replacing a flow, explanation panel, notes for what the user must fill in).
- `assets/js/exporter.js`: JSON (no owner/company ids), PNG (SVG drawn like the canvas), PDF (hand-written writer, picture + card list), shared import parser
  (flows page now uses it, friendly messages). Export dialog warns the JSON contains card settings.
- Polish: filter rows are horizontal, "Login as" is a quiet button, "Soon" scaffolding removed, dark mode checked on all 16 pages, focus ring and reduced motion present.
- Independent review: approved, no critical/high; fixed leading quotes in queries, quotes in conditions, Windows reserved file names, non-numeric coordinates, replace race toast.

## Phase 11 – hardening and docs — DONE
- Store: `saveSoon()` (batched 250 ms) for run progress and sign-in bookkeeping, `flush()` on shutdown/close/SIGINT/SIGTERM, failed delayed writes retried and logged;
  durable `save()` kept for changes a person waits for. Retention (`services/retention.js`): newest 50 runs per company always kept, then 90 days / 500, audit capped at 20000.
- Tests added: credit exhaustion (e2e), restart persistence and startup retention (unit), store debounce, retention, plus everything for phases 8-10.
- `docs/MIGRATION.md` (module map, MySQL model, impersonation as JWT `act` claim, Socket.IO mapping, simulated parts), README rewritten, `/security-scan`
  (AgentShield on `.claude`: grade A, 0 findings) and a whole-app security review.

## Final whole-app security review (phase 11) — fixed and accepted
- Found: 1 high, 6 medium, 6 low, no critical. **Fixed:** company import now validates every card like a normal save, 5 MB total cap, 6 MB body limit (was 25 MB);
  nobody can reset their own password or change their own email through the users API (must use My account with the current password);
  full and company exports are audited; sessions capped at 10 and devices at 20 per person; locks only on cards that exist, max 20 per tab;
  the server refuses to start with `NODE_ENV=production` and the fake payment gateway.
- **Accepted for the prototype, listed for the real stack:** the audit log can be pushed out by many cheap writes (move to archive tables), the shared seed password and
  auto-fill demo panel (README "Remove before deployment"), registration reveals whether an email exists, one-minute per-email lockout, no global SSE cap,
  admin run list is O(runs x steps) (use SQL joins in the real stack), Google Fonts without SRI.

## Phase 0 – Part A: ECC install — DONE
- node v24.19.0, git 2.55.0. Official `affaan-m/ECC` cloned to `D:\FYP\_tools\ECC`, installed with
  `.\install.ps1 --profile full --target claude --enable-hooks`; doctor OK; 8 required skills + 76 agents present.
- The one non-zero installer exit was my own `Select-Object -First 15` closing the pipe; re-run exits 0.
- GateGuard hook asks for facts before first writes/destructive commands; batch work accordingly.

## Phase 1 – design system, shell, login/register, db.js, server.js, seed — DONE, theme APPROVED by the owner
- Theme "Signal Bench" approved; Instrument Sans + Bricolage Grotesque and the node colour spine are kept
  (impeccable `side-tab` and `overused-font` suppressions record "user confirmed").
- Review fixes applied (rate-limit bypass, private flows hidden from colleagues, Secure cookie, etc.).

## Phase 2 – auth, roles, sessions, devices, tenancy — DONE
- `server/services/users.js`: list/create/update/delete users, reset password, freeze/unfreeze, seat limits
  (plan seats + extra seats, frozen count), devices, login events, audit entries (incl. `security.cross_tenant_attempt`).
- Server: param router (`addRoute`), `/api/users*`, `/api/devices`, `/api/login-events`, `/api/seats`.
- Review (fresh context): no critical/high. Fixed: deleting a company's last admin no longer destroys flows (409),
  email change revokes sessions and audits old/new email, denied cross-tenant probes are audited, more HTTP tests.
  Accepted: 409 "email exists" reveals that an email is registered somewhere (inherent to globally unique emails).
- Tests: unit 90 total at end of phase 3; Playwright e2e added (`playwright.config.js`, `tests/e2e/`), throwaway data dir,
  port 3100, `npm run test:e2e`.

## Phase 3 – super admin pages — DONE (review running at time of writing; see below for fixes)
- `server/services/tenants.js` (list/create/detail/update plan+seats/freeze/delete/platform stats), `ledger.js`
  (invoices, payments, audit; super sees all, company admin own), `backup.js` (full DB export/import for super admin;
  company flows export/import for admins, ids and tenant never trusted).
- Pages: `super/dashboard`, `tenants`, `tenant-detail`, `payments`, `audit` + controllers in `assets/js/pages/super-*.js`,
  shared `assets/js/ui-kit.js` (dialogs, forms, tables, charts, file helpers) and `pages/account-actions.js`.
- `db.js` now has one `ENDPOINTS` table; every server feature goes through `AF.db.*`. In offline (no server) mode those
  features answer "This feature needs the AgentFlow server" (only sign-in and the flows list work offline for now).
- Verified: 90 unit tests, 18 e2e tests (4 role logins, frozen messages, tenant isolation via UI and direct API,
  company create/freeze/unfreeze/plan/seat/account actions, payments + audit filters, export/import round trip,
  bad import rejection). Visually checked dashboard and company detail.

## Phase 3 review fixes (done)
- Whole-DB import validates every entry (objects, ids unique, hashes present, companies exist), requires the importer's own
  super admin account, strips `__proto__`/`constructor`/`prototype`, never mutates live data; `Store.replace` forces a backup
  first and rolls back on a failed write. Company import caps (500 flows/company, 200 cards, 400 connections). Company freeze is
  idempotent; deleting a company also clears presence/locks. Confirm dialogs focus Cancel first (type-to-confirm dialogs focus the text box).

## Phase 4 – admin pages, seats, billing, simulated checkout, invoices — DONE
- Pages: `admin/dashboard`, `employees` (seat bar, add/edit/reset/freeze/delete), `billing` (plans, extra seats, card checkout, invoices with
  print, pay overdue invoice), `activity` (devices, browsers, sign-ins, audit). `server/services/billing.js`, `adapters/payment.js`
  (shared card validation, Luhn, brand lengths; `FakeGateway` with test cards 4242…/…0002 declined/…9995 no funds; only brand + last4 stored).
- Review fixes: failed payments are saved to disk (402 persists), a failed save reloads the last saved state and says nothing changed,
  frozen companies cannot buy/change/pay, cent rounding, Amex = 15 digits / Mastercard = 16. Accepted limitation: invoice numbers are
  max+1 (reused if the newest invoice is deleted), no idempotency key (the checkout button disables while submitting).
- Test-found bug fixed: `el()` flattened only one level of nested children (invoice details showed "[object HTMLElement]").

## Phase 7 – engine runner, runs, credits, runs page — DONE, STOPPED as requested
- `engine.js` `Engine.run` (Condition/Loop, per-step records, maxSteps 200, loop counts 1-10, Stop flag, charge/refund hooks), `server/services/runs.js`
  (server runs the SAVED flow snapshot; per-step credit charge is synchronous so concurrent runs cannot overspend; 402 when credits are gone, 400 with the
  problem list for an invalid flow, 429 over 3 concurrent runs, interrupted runs marked failed on restart), `credits.js`, fake AI/search/mail adapters.
- UI: Run/Stop button (Ctrl+Enter) with live card status and the results drawer (Results / Live logs / Context variables) in the builder, `app/runs.html` with filters
  and per-step detail modal, shared `pages/run-view.js`.
- Review (fresh context): no critical/high. Fixed: repeated Stop requests no longer grow the log. Accepted for the demo: runs/runSteps are never pruned and each
  step rewrites db.json synchronously (add retention + debounced saves in phase 11).
- Verified: 215 unit tests, 61 Playwright e2e tests (new `tests/e2e/runs.spec.js`: refuse-with-problems, run, history, details, search; privacy across employee,
  company admin, other tenant and super admin). Note: Kestrel Freight is frozen in the seed, so use `solo@example.test` as the outsider in e2e.

## Phase 5 review + Phase 6 – builder canvas and node registry — DONE, STOPPED FOR OWNER REVIEW OF THE CANVAS
- Independent review of phases 5+6 (it read the services, routes and the first part of builder.js, not canvas/engine/tests). Fixed: `base_version` is now
  required for name/graph saves (no blind overwrites), versions per flow capped at 200 (oldest pruned) and flow quotas (500 per company, 50 per individual),
  `__proto__`/`constructor`/`prototype` stripped from card settings and custom cards, wrong "current password" attempts throttled per account (5/min),
  profile changes audited, a Plus upgrade creates the usage record if missing, and an edit made while a save is in flight now stays "unsaved".
  Accepted/unchanged: company admins can see all company flows including private ones (intended); the server stays lenient about unknown card types
  and ports (the client shows "Unknown card type" and refuses to run them).
- Built: `assets/js/nodes.js` (registry: 12 cards, each one object with id/category/icon/label/description/ports/fields/summary; custom "My cards" made from a built-in
  card, stored in the user's preferences via `PUT /api/account/cards`), `engine.js` validation (`validateFlow`, `checkConnection`: missing Start/End, one Start, unconnected,
  unreachable, dead ends, required/invalid settings, YES/NO and EACH/DONE branches, cycles unless a Loop is involved; messages are shown ON the cards),
  `canvas.js` (infinite pan/zoom canvas, drag from library, drag output pin to connect, curved wires, select/delete wire, duplicate, undo/redo, auto-align,
  fit, keyboard shortcuts, read-only mode, free-spot placement), `pages/builder.js` + `app/builder.html` (library with search, settings form generated from the
  schema, problems list, save with conflict dialog, results drawer shell, shortcuts dialog, "needs a bigger screen" below 900px).
- Not built yet and shown disabled: Run (phase 7), History (8), Export (10), AI Flow Architect prompt (10); the results drawer is an empty shell until phase 7.
- Verified: 170 unit tests (87% lines overall; engine 99%, nodes 99%, flows/account/billing/tenants services 100%; `canvas.js` interactive class is covered by e2e),
  53 Playwright e2e tests (14 for the builder: add by click/drag, connect, delete wire, undo/redo, duplicate, nudge, align, zoom, save → version, reload, conflict,
  My cards, read-only, bad flow id, phone-size message). A syntax test now parses every script so a broken browser-only file fails fast.
- Bugs found by tests while building: nested children rendering as "[object HTMLElement]" (fixed), settings fields stringified by native `replaceChildren`
  (fixed), new cards landing on top of existing ones (now placed on a free spot), keyboard shortcuts dead when focus was on a library button (now page-wide),
  duplicate firing twice (event marked handled), "Save as my card" saving stale settings (fixed), `//` comment swallowing a line in builder.js (fixed, syntax test added).
- Screenshots for the owner: `docs/screenshots/builder-canvas-light.png`, `builder-canvas-dark.png`, `builder-problems-light.png`.

## Phase 5 – flows list, templates, account, credits — DONE
- `server/services/flows.js` (list/get/create/save with versions + conflict detection/share/delete/duplicate/templates, graph validation:
  ≤200 cards, ≤400 connections, ids/types/positions/config size checked, graph rebuilt from trusted fields), `account.js` (usage, profile,
  password change keeps this session, own activity, individual Free<->Plus upgrade with card), shared `assets/js/billing.js` (credit costs,
  estimates, status) and `assets/js/versions.js` (plain-language change summaries). Seed: plan `audience` (company/individual), new `Plus` plan.
- Pages: `app/flows` (create, import JSON, rename, duplicate, share inside company, delete, search/filter, credit strip), `templates`, `account`.
- Verified: 134 unit tests, 39 e2e tests.

## Known gaps carried forward
- "Soon" nav tags and disabled "New flow" until phase 5; remove `BUILT` in `ui.js` in phase 11.
- Offline/no-server mode supports sign-in and flows list only (documented limitation; the real product needs the server).
- Demo-account panel on login page and the README "Remove before deployment" checklist.
- `db.json` writes are synchronous per mutation (fine for a demo, batch later).

## Next steps
The owner reviews the builder canvas screenshots (light + dark). If approved (or after requested changes), continue with
phase 7 (engine runner with fake AI/search/mail adapters, runs + per-step results, Stop, credits enforced on the server, runs page, drawer),
8 versions history panel + restore, 9 co-work + locks, 10 AI Flow Architect + export/import PNG/PDF/JSON + polish, 11 hardening, docs, migration notes,
`/security-scan`, final e2e (credit exhaustion, version restore, co-editing in two browser contexts, export/import).
