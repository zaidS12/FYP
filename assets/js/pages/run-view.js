/* Shared rendering of a run: summary, error with a "how to fix" line, final result, per-step details, logs, context variables.
 * Used by the builder's results drawer and by the Runs page. All text goes through AF.ui.el (never innerHTML). */
(function (root) {
  'use strict';
  const AF = root.AF; const { el } = AF.ui; const K = AF.kit;

  const HINTS = {
    search_timeout: 'Check your connection and run again. (In this demo, a search query containing [fail] always times out; remove it.)',
    empty_query: 'Open the Search Web card and fill in the search query.',
    mail_rejected: 'Open the Write Email card and check the "Send to" address.',
    bad_address: 'Open the Write Email card and fix the "Send to" address.',
    ai_unavailable: 'The AI service did not answer. Wait a moment and run the flow again.',
    credits_exhausted: 'Credits are used up. Ask your company admin to upgrade the plan in Billing, or upgrade on your account page if you have a personal account. Credits also renew every month.',
    bad_expression: 'Open the Condition card and use a check such as length > 200, contains "error" or is empty.',
    bad_code: 'Open the Python Code card and remove the code the message mentions.',
    too_many_steps: 'Check the Loop cards: a loop that repeats too often can run past the limit of 200 steps.',
    invalid_flow: 'Open the builder, fix the problems marked on the cards, save, and run again.',
    interrupted: 'The server was restarted during the run. Run the flow again.',
  };
  const hintFor = code => HINTS[code] || 'Open the card that failed, check its settings, and run again.';
  const STATUS = { running: ['Running…', 'warn'], success: ['Finished', 'ok'], failed: ['Failed', 'danger'], stopped: ['Stopped', ''], skipped: ['Skipped', ''] };
  const statusBadge = s => K.badge((STATUS[s] || [s, ''])[0], (STATUS[s] || [s, ''])[1]);
  const duration = ms => (ms < 1000 ? Math.round(ms) + ' ms' : (ms / 1000).toFixed(1) + ' s');
  const clock = iso => { const d = new Date(iso); return isNaN(d) ? '' : d.toLocaleTimeString([], { hour12: false }); };

  function summary(run) {
    return K.kv([['Flow', run.flow_name + (run.flow_version ? ' (version ' + run.flow_version + ')' : '')], ['Status', statusBadge(run.status)], ['Started', K.formatDateTime(run.started_at)],
      ['Duration', duration(run.duration_ms)], ['Credits used', String(run.credits)], ['Run by', run.user_name]]);
  }

  function problem(run) {
    if (run.status === 'stopped') return el('div', { class: 'notice', role: 'status' }, 'This run was stopped before it finished. Credits were only used for the cards that ran.');
    if (run.status !== 'failed') return null;
    return el('div', { class: 'alert', role: 'alert' }, el('strong', { text: 'This run failed. ' }), run.error || 'Something went wrong.', el('div', { class: 'hint', text: 'How to fix: ' + hintFor(run.error_code) }));
  }

  function output(run) {
    if (run.output == null || run.status === 'running') return null;
    const copy = el('button', { type: 'button', class: 'btn btn-sm btn-secondary', text: 'Copy result', on: { click: async () => { try { await navigator.clipboard.writeText(run.output); AF.ui.toast('Result copied.'); } catch (e) { AF.ui.toast('Select the text and press Ctrl+C to copy.', 'error'); } } } });
    return el('div', { class: 'run-result' }, el('div', { class: 'row between' }, el('h3', { text: run.result_title || 'Final result' }), copy), el('pre', { class: 'run-output', text: run.output }));
  }

  /** One collapsible row per card that ran. onPick(node_id) lets the caller highlight the card. */
  function steps(list, onPick) {
    if (!list.length) return el('p', { class: 'muted', text: 'No card has started yet.' });
    return el('div', { class: 'steps' }, list.map(s => {
      const head = el('summary', {}, el('i', { class: 'dot is-' + s.status, 'aria-hidden': 'true' }), el('span', { class: 'step-n', text: String(s.n) }), el('b', { text: s.label }),
        el('code', { class: 'muted', text: s.type + (s.loop_index ? ' · round ' + s.loop_index : '') + (s.branch ? ' · ' + s.branch.toUpperCase() : '') }), el('span', { class: 'grow' }),
        el('span', { class: 'muted', text: s.status === 'running' ? 'running…' : duration(s.ms) }), el('span', { class: 'muted', text: s.credits + ' cr' }), statusBadge(s.status));
      if (onPick) head.addEventListener('click', () => onPick(s.node_id));
      const body = el('div', { class: 'step-body' }, s.error ? el('p', { class: 'field-error', text: s.error }) : null,
        el('h4', { text: 'Input' }), el('pre', { class: 'run-output', text: s.input || '(empty)' }), el('h4', { text: 'Output' }), el('pre', { class: 'run-output', text: s.output == null ? (s.status === 'running' ? '…' : '(none)') : s.output }));
      return el('details', { class: 'step is-' + s.status }, head, body);
    }));
  }

  function logs(run) {
    if (!(run.logs || []).length) return el('p', { class: 'muted', text: 'No log lines yet.' });
    return el('div', { class: 'logs', role: 'log' }, run.logs.map(l => el('div', { class: 'log is-' + l.level }, el('span', { class: 'muted', text: clock(l.at) }), el('b', { text: l.level.toUpperCase() }), el('span', { text: l.message }))));
  }

  /** The text passed between cards ("context variables"): what each card produced. */
  function variables(list) {
    const done = list.filter(s => s.output != null);
    if (!done.length) return el('p', { class: 'muted', text: 'Nothing has been produced yet.' });
    return K.kv(done.map(s => [s.label + (s.loop_index ? ' (round ' + s.loop_index + ')' : ''), el('pre', { class: 'run-output small', text: s.output.length > 400 ? s.output.slice(0, 400) + '…' : s.output })]));
  }

  AF.runView = { hintFor, statusBadge, duration, summary, problem, output, steps, logs, variables };
})(self);
