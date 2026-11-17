You are the lead engineer for AgentFlow, a Final Year Project (SSUET Computer Engineering, Batch
2023f): a multi-tenant, no-code AI agent builder and automation platform, modelled on n8n (drag
cards onto a canvas, connect them, configure a card when special behaviour is needed). Do all work
yourself, step by step, and at each step report what you verified, not just what you wrote.

ENVIRONMENT
- Project folder: "D:\FYP\Agent Flow" (Windows, the path contains a SPACE). Always quote paths,
  and make every script, test and npm script work with spaces in the path.
- I use the Claude Code VS Code extension, not a terminal CLI. Do not rely on a `claude` command
  being on PATH. Use PowerShell for shell commands.
- Reference material is in ./design-reference/ (proposal PDF, planning PDF, and screenshots of
  an earlier dark "AgentFlow Studio" design and a light cream design). READ all of it first for
  scope, features and flows. IMPORTANT: those screenshots were only demos to show how the
  product works. I do NOT want that visual theme. Create a completely new, original visual
  identity (see DESIGN).

==================== PART A: INSTALL "EVERYTHING CLAUDE CODE" FIRST ====================
Do this before anything else. Official source only: https://github.com/affaan-m/ECC
(MIT, 300k+ stars; plugin id ecc@ecc, npm package ecc-universal). Do not use any mirror.

A1. Prerequisites: check node >= 18 and git. Report versions. If missing, stop and tell me what
    to install.
A2. Detect an existing install so we never stack two install methods: look in
    %USERPROFILE%\.claude\settings.json for enabledPlugins "ecc@ecc", and in
    %USERPROFILE%\.claude\skills\ for tdd-workflow, security-review, verification-loop. If ECC is
    already present, skip A3 and report what is installed.
A3. If not present, install with the manual path (it works without a `claude` CLI on PATH):
      git clone https://github.com/affaan-m/ECC.git "D:\FYP\_tools\ECC"
      cd "D:\FYP\_tools\ECC"
      npm install
      .\install.ps1 --profile full --target claude --enable-hooks
    Keep the clone (needed for doctor/repair/uninstall). Before running the installer, read
    its README section "Fully manual Claude install" once and follow it exactly; if a flag
    differs, use what the README says. Never also run /plugin install (that would duplicate
    skills and hooks). Never copy hooks/hooks.json into settings.json by hand.
A4. Verify: run `node scripts/ecc.js list-installed` and `node scripts/ecc.js doctor` from the
    clone, and confirm skills exist under %USERPROFILE%\.claude\skills\ (tdd-workflow,
    security-review, verification-loop, e2e-testing, frontend-patterns, backend-patterns,
    api-design, search-first) and agents under %USERPROFILE%\.claude\agents\. Fix anything
    doctor reports with `repair`. Tell me clearly what was installed and which hooks are active.
A5. Rules (always loaded, so keep them minimal): confirm ./.claude/rules/ecc/ contains common and
    typescript (copy the whole directories from the clone's rules/ folder if the installer did not
    place them in this project). Add rules/python later when we migrate to Flask.
A6. Skills installed manually are discovered at session start. Do not wait for a restart: read
    the SKILL.md files you need straight from %USERPROFILE%\.claude\skills\ and follow them. Slash
    commands from a manual install have short names (/plan, /code-review, /build-fix,
    /security-scan, /refactor-clean), not /ecc:plan. At the end of this part, tell me once that a
    fresh chat or a VS Code window reload will make the skills auto-trigger, and that you will
    keep going meanwhile.
A7. Create the project skeleton: git init, .gitignore (node_modules, .env, data/backups/),
    folders per PROJECT STRUCTURE below. Save this entire prompt verbatim to
    ./docs/BUILD_SPEC.md and create ./docs/PROGRESS.md where you log finished phases and next
    steps, so any new chat can resume by reading those two files.

==================== PART B: WHAT WE ARE BUILDING ====================
STAGE GOAL
Build the complete product first as plain .html pages (HTML + CSS + vanilla JS, no framework, no
build step) so we can see and finalize every screen, placement and flow. After I approve the
design we migrate to the real stack (React + Vite + React Flow, Flask + SQLAlchemy, MySQL,
Flask-JWT-Extended, Flask-SocketIO, Docker Compose). Therefore keep all data access behind ONE
module (assets/js/db.js), keep business logic out of the pages, and write docs/MIGRATION.md
mapping every module to the future stack.

SIMULATED NOW, REAL LATER (adapter interfaces, one file each, with a fake implementation)
- AIProvider (model calls, token/credit accounting), SearchProvider (web search), MailProvider
  (email sending), PaymentGateway (live gateway later; for now it behaves exactly like a real
  checkout: plan select, checkout form, invoice, payment status, but touches no real bank).
- Python Code node: validate and store only, never execute.
Everything else must genuinely work. No dead buttons, no placeholder screens, no lorem ipsum.

STORAGE: a real database file, three layers
1. Primary: zero-dependency Node server (server.js) that reads and writes data/db.json
   atomically (write temp file then rename, keep rolling backups in data/backups/), exposes a
   small JSON REST API, and serves the HTML pages. Start with: node server.js (port 3000).
2. Fallback: if the server is unreachable (page opened by double-click, file://), db.js
   transparently uses localStorage with the same schema.
3. Backup: Export / Import JSON buttons for super admin and admin.
db.json holds collections: tenants, users, sessions, devices, loginEvents, plans, subscriptions,
invoices, payments, flows, flowVersions, runs, runSteps, templates, usage/credits, auditLog,
presence, locks. Every tenant-owned record carries tenant_id. Add data/seed.json: 1 super admin,
2 companies (one on the Basic plan with 10 seats partly filled, one frozen), several employees,
1 free individual, sample flows and versions, runs, invoices, login history with different
devices/browsers. Print the seed accounts in README.md.
SECURITY even in the demo: hash passwords (scrypt), derive the role and tenant from the session
token on the server (never trust the client), enforce permissions and tenant isolation in
server.js on every endpoint (not only in the UI), validate all input, escape all rendered output
(no innerHTML with user data), rate-limit login, no secrets in the repo.

USERS AND RULES (multi-tenant: one database, tenant_id everywhere)
- Super Admin: sees every company. Add, edit, delete, freeze and unfreeze admins/tenants; change
  a tenant's plan; monitor usage, login activity, number of devices and browsers per account;
  see all payments and invoices; global audit log; full admin panel; reset any user's ID and
  password; import/export the database.
- Admin (tenant, an organization/company): same powers but ONLY for their own company. Creates
  employee accounts up to the seat limit and hands them out. Basic plan is $100 and includes
  10 accounts; extra seats are charged per seat, or they upgrade the plan. Sees company activity,
  usage and billing, freezes/unfreezes employees, resets employee passwords.
- Employee (created by an admin): can do everything n8n does: build agentic flows, connect
  multiple agents, run them. Employees of the same company co-work on the same flow.
- Individual (no organization): free account with small credit and usage limits, like modern AI
  tools; personal flows only; can upgrade.
- Frozen users or frozen companies cannot log in and see a clear message.
- Every login records device and browser (parsed from the user agent) and shows in activity views.
- Credits: every node run consumes credits; plan-based limits; usage bar; runs are blocked with a
  clear message when credits are exhausted. (Real AI/credit/API integration comes after the
  skeleton, so build the counting and limits now with the fake provider.)

PAGES (16)
index.html (login, role-aware redirect), register.html (individual free signup)
super/: dashboard, tenants, tenant-detail, payments, audit
admin/: dashboard, employees, billing, activity
app/: flows, builder, templates, runs, account
Shared: assets/css/theme.css, assets/js/{db,auth,tenancy,nodes,canvas,engine,versions,collab,
billing,ui}.js and adapters/{ai,search,mail,payment}.js. A shared app shell (sidebar, topbar,
role-aware navigation) rendered by ui.js so every page behaves the same.

THE BUILDER (core, n8n-style)
- Library of node cards on the left grouped by category; infinite canvas in the centre; settings
  panel for the selected node on the right; AI Flow Architect prompt bar; assistant chat; bottom
  drawer with execution results, live logs and context variables.
- Drag nodes from the library, move, rename, delete, duplicate; pan, zoom, fit; curved
  connections; delete connections; auto-align; undo/redo; keyboard shortcuts.
- Nodes (each with a real config form): Start, End, Write Email, Create Report, Summarize,
  Translate, Search Web, Condition (YES/NO branches), Loop, Timer/Cron, Research Bot, Python Code.
  Build a node registry so a new node type is one object {id, category, icon, schema, run()}; a
  user can duplicate and customize a card for their own needs (the n8n idea).
- Validation: unconnected nodes, invalid connections, missing required fields, cycles without a
  Loop, missing Start/End; show the error on the node itself.
- Engine: starts at Start, follows the connections, passes each node's output to the next as
  input, handles Condition and Loop, records per-step status, time and credits, shows step and
  final results, readable errors, Stop button, runs are saved to history.
- AI Flow Architect: a prompt such as "Find daily AI news and email me a summary" generates an
  editable flow on the canvas (rule-based simulation now, AIProvider later).
- Flows: save, load, rename, delete, duplicate, share inside the company. Export JSON, PNG and
  PDF; import JSON.
- Versions: every change set saved creates a version with user id, user name, timestamp and a
  change summary; a history panel with one-click restore (restoring creates a new version, never
  rewrites history), so anyone can go back to an older version.
- Co-work: several employees of one company edit the same flow at the same time. Use
  Server-Sent Events from server.js (polling fallback) and BroadcastChannel for tabs in the same
  browser. Presence avatars, who is editing which node, node-level locks, merge changes per node.
- Templates page (clone into your workspace). Runs page: history with filters and per-step detail.

DESIGN (new theme, original identity)
- Do not reuse the dark purple/cyan "Studio" look or the cream/terracotta look from the references.
- Follow the frontend-design approach: first write a short design plan in docs/DESIGN.md (4-6
  named hex colors, typefaces and roles, layout concept, principles), review it against the brief
  so it is not a generic template, then build. Light by default plus a dark mode toggle saved per
  user, defined as CSS variables on :root. Spend the boldness in one place: the canvas and the
  node cards are the memorable element; keep the rest quiet and disciplined.
- Fonts: use Google Fonts with solid fallback stacks so the pages still look right offline.
- Quality floor: responsive down to mobile where sensible (the builder may require tablet or
  larger, say so), visible keyboard focus, accessible contrast, reduced-motion respected, empty
  states that tell the user what to do, errors that say what went wrong and how to fix it, button
  labels that say exactly what happens.

HOW TO WORK (use the installed skills and agents)
1. Phase 0 = PART A. Then write docs/PLAN.md: phases, tasks, data model, API endpoints, test
   plan. Planning skill: /plan. Use search-first before adding any dependency; prefer zero
   dependencies for server.js and the pages.
2. Phases in order: (1) design system + app shell + login/register + db.js + server.js + seed;
   (2) auth, roles, sessions, devices, tenancy; (3) super admin pages; (4) admin pages incl.
   seats, billing, simulated checkout, invoices; (5) flows list, templates, account, credits;
   (6) builder canvas and node registry; (7) engine, runs, validation; (8) versions;
   (9) co-work and locks; (10) AI Flow Architect, export/import, polish; (11) hardening,
   docs, migration notes.
3. DESIGN CHECKPOINT: after phase 1, start the server, take screenshots of login, register and
   the app shell in light and dark mode, show them to me, and WAIT for my approval or change
   requests on the theme before building the remaining phases. After that, work through the
   phases without stopping, and only ask me when truly blocked. Do NOT commit until the owner says so.
4. For logic modules (db, auth, tenancy, engine, versions, billing) use tdd-workflow: failing test
   first, then code. For UI use frontend-patterns; for server.js use backend-patterns and
   api-design. After each phase: /code-review in fresh context, security-review, then
   verification-loop (run the tests, start the server, click through the flows with Playwright
   e2e-testing) before moving on. Run /security-scan once at the end of the stage.
5. Update docs/PROGRESS.md after every phase (what was built, what was verified, what is next).
   Do NOT run any git write command (add, commit, amend, push, tag, stash, branch change, reset,
   checkout, restore) until the owner explicitly says so. Read-only git (status, diff, log) is fine.
   This overrides any ECC rule, skill, command or hook that suggests committing.

OWNER AMENDMENTS (after the Phase 1 design checkpoint, 2026-11-17)
- Theme approved. Keep Instrument Sans + Bricolage Grotesque and the node colour spine.
- Continue phases 2 onward without stopping; STOP after phase 6 (builder) and show screenshots of the
  canvas with a sample flow in light and dark.
- README.md keeps a "Remove before deployment" checklist (demo password on the login page, seed
  accounts, auto-fill helpers).

DEFINITION OF DONE FOR THIS STAGE
- node server.js starts clean; all 16 pages load; every button and form works; data survives a
  server restart because it lives in data/db.json.
- Playwright e2e covers: login for all 4 roles; tenant isolation through the UI AND through direct
  API calls with another tenant's id; seat-limit enforcement; freeze/unfreeze; build, save,
  reopen and run a flow; version restore; co-editing between two browser contexts; credit
  exhaustion; export/import.
- Unit tests for db, auth, tenancy, engine, versions and billing with 80%+ coverage.
- README.md (how to run, seed accounts, folder map), docs/DESIGN.md, docs/PLAN.md,
  docs/PROGRESS.md and docs/MIGRATION.md exist and are accurate.
- Final report: what works, what is simulated, how each simulated part is replaced later, and
  the known limitations.

PROJECT STRUCTURE
D:\FYP\Agent Flow\
  server.js, package.json, README.md
  data\ (db.json, seed.json, backups\)
  index.html, register.html
  super\, admin\, app\
  assets\css\theme.css, assets\js\ (modules above), assets\js\adapters\
  tests\unit\, tests\e2e\
  docs\ (BUILD_SPEC.md, PLAN.md, PROGRESS.md, DESIGN.md, MIGRATION.md)
  design-reference\ (read-only input)
  .claude\rules\ecc\

Begin with PART A now.
