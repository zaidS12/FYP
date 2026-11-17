'use strict';
/* Three-way, per-card merge of two edits made from the same base version.
 * base = the version both people opened, mine = what this person is saving, theirs = what is saved now.
 * A card changed by only one side is taken from that side; changed by both in different ways is a conflict. */

/** Key-sorted JSON, so the same card never looks "changed" just because its keys arrived in another order. */
const stable = v => JSON.stringify(v, (k, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.keys(x).sort().map(key => [key, x[key]])) : x));
const same = (a, b) => stable(a) === stable(b);
const edgeKey = e => [e.from, e.fromPort || 'out', e.to, e.toPort || 'in'].join('|');
const byId = list => new Map(list.map(x => [x.id, x]));

/** Ids of cards added, removed or changed in `mine` compared with `base`. */
function changedNodeIds(base, mine) {
  const b = byId(base.nodes); const m = byId(mine.nodes); const out = [];
  for (const [id, node] of m) if (!b.has(id) || !same(b.get(id), node)) out.push(id);
  for (const id of b.keys()) if (!m.has(id)) out.push(id);
  // Adding or removing a connection changes both cards it touches.
  if (Array.isArray(base.edges) && Array.isArray(mine.edges)) {
    const be = new Map(base.edges.map(e => [edgeKey(e), e])); const me = new Map(mine.edges.map(e => [edgeKey(e), e]));
    for (const [k, e] of me) if (!be.has(k)) out.push(e.from, e.to);
    for (const [k, e] of be) if (!me.has(k)) out.push(e.from, e.to);
  }
  return [...new Set(out)];
}

/** Two people who each added a different card get the same new id (n7). Give mine a fresh id so both survive. */
function renameClashes(base, mine, theirs) {
  const b = new Set(base.nodes.map(n => n.id)); const t = byId(theirs.nodes);
  const taken = new Set([...b, ...t.keys(), ...mine.nodes.map(n => n.id)]);
  const rename = new Map();
  for (const n of mine.nodes) if (!b.has(n.id) && t.has(n.id) && !same(n, t.get(n.id))) {
    let id = n.id + 'm'; while (taken.has(id)) id += 'm';
    taken.add(id); rename.set(n.id, id);
  }
  if (!rename.size) return mine;
  const r = id => (rename.has(id) ? rename.get(id) : id);
  return { name: mine.name, nodes: mine.nodes.map(n => (rename.has(n.id) ? Object.assign({}, n, { id: rename.get(n.id) }) : n)),
    edges: mine.edges.map(e => Object.assign({}, e, { from: r(e.from), to: r(e.to) })) };
}

function mergeNodes(base, mine, theirs) {
  const b = byId(base.nodes); const m = byId(mine.nodes); const t = byId(theirs.nodes);
  const ids = [...new Set([...theirs.nodes.map(n => n.id), ...mine.nodes.map(n => n.id), ...base.nodes.map(n => n.id)])];
  const nodes = []; const conflicts = [];
  for (const id of ids) {
    const bn = b.get(id); const mn = m.get(id); const tn = t.get(id);
    let pick;
    if (!bn) {
      if (mn && tn && !same(mn, tn)) { conflicts.push({ node_id: id, label: mn.label, reason: 'You and a colleague both added a card with the same identity.' }); continue; }
      pick = tn || mn;
    } else if (same(mn, bn)) pick = tn;           // I left it alone: take theirs (or their deletion)
    else if (same(tn, bn)) pick = mn;             // they left it alone: take mine (or my deletion)
    else if (same(mn, tn)) pick = mn;             // identical change
    else { conflicts.push({ node_id: id, label: (mn || tn || bn).label, reason: mn && tn ? 'You and a colleague both changed this card.' : 'One of you deleted this card while the other changed it.' }); continue; }
    if (pick) nodes.push(pick);
  }
  return { nodes, conflicts };
}

function mergeEdges(base, mine, theirs, nodeIds) {
  const keys = list => new Map(list.map(e => [edgeKey(e), e]));
  const b = keys(base.edges); const m = keys(mine.edges); const t = keys(theirs.edges);
  const out = [];
  for (const k of new Set([...b.keys(), ...m.keys(), ...t.keys()])) {
    const inB = b.has(k); const inM = m.has(k); const inT = t.has(k);
    const keep = inB ? inM && inT : inM || inT;     // a removal by either side wins; an addition by either side is kept
    if (!keep) continue;
    const edge = t.get(k) || m.get(k);
    if (nodeIds.has(edge.from) && nodeIds.has(edge.to)) out.push(edge);
  }
  return out;
}

/** {ok:true, merged:{name,nodes,edges}} or {ok:false, conflicts:[{node_id,label,reason}]}. */
function mergeGraph(base, mine0, theirs) {
  const mine = renameClashes(base, mine0, theirs);
  const conflicts = [];
  let name;
  if (same(mine.name, base.name)) name = theirs.name;
  else if (same(theirs.name, base.name) || same(mine.name, theirs.name)) name = mine.name;
  else { name = theirs.name; conflicts.push({ node_id: null, label: 'Flow name', reason: 'You and a colleague both renamed the flow.' }); }
  const n = mergeNodes(base, mine, theirs);
  conflicts.push(...n.conflicts);
  if (conflicts.length) return { ok: false, conflicts };
  const edges = mergeEdges(base, mine, theirs, new Set(n.nodes.map(x => x.id)));
  // Both sides may have drawn "e5": keep every connection but give repeated ids a fresh one.
  const seen = new Set(); let next = 1;
  const fixed = edges.map(e => {
    if (!seen.has(e.id)) { seen.add(e.id); return e; }
    while (seen.has('e' + next) || edges.some(x => x.id === 'e' + next)) next += 1;
    const id = 'e' + next; seen.add(id); return Object.assign({}, e, { id });
  });
  return { ok: true, merged: { name, nodes: n.nodes, edges: fixed } };
}

module.exports = { mergeGraph, changedNodeIds };
