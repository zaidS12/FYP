/* Templates: browse ready-made flows and clone one into your own workspace. */
(async function () {
  'use strict';
  const { el } = AF.ui; const K = AF.kit;
  const ctx = await AF.ui.boot({ roles: ['superadmin', 'admin', 'employee', 'individual'], title: 'Templates' });
  if (!ctx) return;
  const canClone = ctx.user.role !== 'superadmin';
  const host = document.getElementById('host');
  document.getElementById('sub').textContent = canClone ? 'Start from a ready-made flow. It is copied into your workspace, so you can change it freely.' : 'Ready-made flows people can start from (read only for super admins).';
  const KIND = { start: 'trigger', timer: 'trigger', search_web: 'data', research_bot: 'ai', summarize: 'ai', translate: 'ai', write_email: 'output', create_report: 'output', condition: 'logic', loop: 'logic', python_code: 'code', end: 'output' };

  function use(t) {
    K.formModal({ title: 'Use "' + t.name + '"', intro: 'A private copy is created for you and opened in the builder.', submitLabel: 'Create my flow',
      fields: [{ name: 'name', label: 'Name your flow', value: t.name, required: true, maxlength: 120 }],
      onSubmit: async v => { const r = await AF.db.cloneTemplate(t.id, { name: v.name }); if (r.ok) location.href = 'builder.html?id=' + encodeURIComponent(r.flow.id); return r; } });
  }

  K.load(host, async () => {
    const r = K.must(await AF.db.listTemplates());
    if (!r.templates.length) return el('div', { class: 'empty' }, el('h2', { text: 'No templates yet' }), el('p', { text: 'Templates will appear here. Meanwhile you can build a flow from scratch.' }));
    return el('div', { class: 'grid-3' }, r.templates.map(t => el('article', { class: 'card tpl' },
      el('div', { class: 'row between' }, K.badge(t.category), el('span', { class: 'muted', text: t.node_count + ' cards' })),
      el('h3', { text: t.name }), el('p', { class: 'muted', text: t.description }),
      el('div', { class: 'chain', 'aria-label': 'Steps: ' + t.nodes.map(n => n.label).join(', ') }, t.nodes.slice(0, 6).map(n => el('span', { class: 'chip chip-' + (KIND[n.type] || 'ai'), title: n.label, text: n.label }))),
      canClone ? el('button', { class: 'btn btn-primary', type: 'button', 'aria-label': 'Use template ' + t.name, text: 'Use this template', on: { click: () => use(t) } }) : null)));
  });
})();
