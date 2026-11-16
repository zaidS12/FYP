# AgentFlow – Design Plan ("Signal Bench")

## Concept
A calm drafting bench with one loud object on it. The product chrome (sidebar, tables, forms) is
quiet, mineral and disciplined. The **canvas and node cards are the memorable element**: graph
paper under a lamp, with each node a punched *tag* – a card with a notched punch-hole, a colour
spine for its category, and round signal pins where wires attach. Connections are tight
cubic curves; when a flow runs, a lime pulse travels along the wires.

It is deliberately not the earlier dark purple/cyan "Studio" look, nor cream/terracotta.

## Palette (six named colours)
| Name | Hex | Role |
|---|---|---|
| Graphite | `#14201E` | Text, dark surfaces, canvas in dark mode |
| Bone | `#F3F5F1` | Light background |
| Pine | `#1D6B57` | Primary actions, links, focus ring base |
| Signal | `#C8F25A` | Live/active accent: run pulse, pins, selected node. Used only on Graphite or as a fill with Graphite text |
| Ember | `#C73E22` | Errors, destructive actions, failed steps |
| Mist | `#DCE3DE` | Borders, dividers, canvas grid |

Contrast: Graphite on Bone 14.6:1, white on Pine 6.4:1, white on Ember 5.3:1. Signal is never used
as text on light backgrounds (1.4:1).
Node category spines (canvas only): Trigger = Signal, AI = Pine, Data = `#2F5FD0`, Output =
`#D98A12`, Logic = `#5B7C99`, Code = Graphite.

## Typefaces
- **Bricolage Grotesque** – display, page titles, node titles (character without being loud).
- **Instrument Sans** – UI body, forms, tables.
- **JetBrains Mono** – ids, logs, context variables, code.
Fallbacks: `system-ui, "Segoe UI", Roboto, sans-serif` and `ui-monospace, Consolas, monospace`, so
pages are correct offline.

## Layout
- App shell: 232px sidebar (role-aware), 56px topbar (page title, theme toggle, user menu),
  content on an 8px scale, max readable width 1180px for lists.
- Login/register: split screen. Left: the form. Right: a live vignette of three node cards on
  graph paper – the product shown, not described.
- Builder (later): library | canvas | settings, bottom drawer. Needs tablet width or larger
  (≥ 900px); below that it shows a clear "open on a larger screen" message.
- Responsive: sidebar collapses to a top bar menu below 860px.

## Principles
1. One bold place: canvas and cards. Everywhere else restraint – flat surfaces, 1px Mist rules, no gradients, no shadows beyond one soft card lift.
2. Every control says what it does ("Create 3 accounts", not "Submit").
3. Empty states tell the user the next action; errors say what happened and how to fix it.
4. Focus is always visible (3px Pine ring, offset 2px; Signal ring in dark mode).
5. Motion explains state (run pulse, panel slide) and is removed under `prefers-reduced-motion`.
6. Theme tokens live on `:root`; dark mode overrides the same tokens via `[data-theme="dark"]`, saved per user.

## Review against the brief
- *Generic template?* A white card + blue button + gradient hero would be generic. We avoid the gradient hero, use a mineral palette with one electric accent, and make the node tag the signature shape.
- *Boldness in one place?* Yes – only canvas/nodes use category colour, notch geometry and the pulse animation.
- *Original vs references?* Light mode is cool mineral (not cream); dark mode is green-black graphite (not purple); no cyan; terracotta replaced by Ember used strictly for errors.
- *Quality floor?* Contrast figures above; focus, reduced motion, empty states and responsive rules are defined; fonts have offline fallbacks.
