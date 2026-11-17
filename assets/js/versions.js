/* AgentFlow flow versions: plain-language change summaries (UMD: server and browser).
 * Restore rules and the history panel are added in phase 8; they build on summarizeChange. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else { root.AF = root.AF || {}; root.AF.versions = factory(); }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
  const names = list => {
    const shown = list.slice(0, 3).map(n => n.label || n.id).join(', ');
    return list.length > 3 ? `${shown} +${list.length - 3} more` : shown;
  };
  const edgeKey = e => [e.from, e.fromPort || 'out', e.to, e.toPort || 'in'].join('|');

  /** Describes what changed between two {name, nodes, edges} snapshots, at most 200 characters. */
  function summarizeChange(prev, next) {
    const parts = [];
    if (prev.name !== next.name) parts.push(`Renamed the flow from "${prev.name}" to "${next.name}"`);
    const before = new Map(prev.nodes.map(n => [n.id, n])); const after = new Map(next.nodes.map(n => [n.id, n]));
    const added = next.nodes.filter(n => !before.has(n.id)); const removed = prev.nodes.filter(n => !after.has(n.id));
    const settings = [], renamed = [], moved = [];
    for (const n of next.nodes) {
      const p = before.get(n.id); if (!p) continue;
      if (JSON.stringify(p.config || {}) !== JSON.stringify(n.config || {})) settings.push(n);
      if (p.label !== n.label) renamed.push(n);
      if (p.x !== n.x || p.y !== n.y) moved.push(n);
    }
    if (added.length) parts.push(`Added ${plural(added.length, 'card')} (${names(added)})`);
    if (removed.length) parts.push(`Removed ${plural(removed.length, 'card')} (${names(removed)})`);
    if (settings.length) parts.push(`Changed settings of ${names(settings)}`);
    if (renamed.length) parts.push(`Renamed ${plural(renamed.length, 'card')}`);
    const be = new Set(prev.edges.map(edgeKey)); const ae = new Set(next.edges.map(edgeKey));
    const edgesAdded = [...ae].filter(k => !be.has(k)).length; const edgesRemoved = [...be].filter(k => !ae.has(k)).length;
    if (edgesAdded) parts.push(`Added ${plural(edgesAdded, 'connection')}`);
    if (edgesRemoved) parts.push(`Removed ${plural(edgesRemoved, 'connection')}`);
    if (moved.length && !added.length && !removed.length) parts.push(`Moved ${plural(moved.length, 'card')}`);
    const text = parts.join('; ') || 'No changes';
    return text.length > 200 ? text.slice(0, 197) + '…' : text;
  }

  /** "Ana" normally; "Root (as Ana)" when a support person or admin saved while signed in as Ana. */
  function authorLabel(v) {
    const who = (v && v.user_name) || 'Unknown';
    return v && v.by_name ? `${v.by_name} (as ${who})` : who;
  }

  return { summarizeChange, authorLabel };
});
