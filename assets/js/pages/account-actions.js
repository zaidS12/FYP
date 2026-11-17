/* Shared account dialogs and the accounts table. Used by the super admin company view and the company admin Employees page.
 * UI only: the server decides what each role may do; buttons are hidden here just to keep the screen honest. */
(function (root) {
  'use strict';
  const AF = root.AF; const { el } = AF.ui; const K = AF.kit;
  const ROLE_LABEL = { admin: 'Admin', employee: 'Employee', individual: 'Individual', superadmin: 'Super Admin' };

  function tempPasswordDialog(name, password) {
    setTimeout(() => K.secretDialog({ title: 'Temporary password for ' + name, intro: 'Give this password to ' + name + ' and ask them to change it after signing in. It is shown only once, so copy it now.', label: 'Temporary password', value: password }), 0);
  }

  function createAccountDialog({ tenantId, viewer, onDone }) {
    const isSuper = viewer.role === 'superadmin';
    const fields = [{ name: 'name', label: 'Full name', required: true, maxlength: 80, autocomplete: 'off' }, { name: 'email', label: 'Email (this is their sign-in ID)', type: 'email', required: true }];
    if (isSuper) fields.splice(0, 0, { name: 'role', label: 'Role', type: 'select', options: [{ value: 'employee', label: 'Employee' }, { value: 'admin', label: 'Company admin' }] });
    K.formModal({
      title: 'Add an account', intro: 'AgentFlow creates a temporary password you can hand over. The account counts against the company seat limit.', fields, submitLabel: 'Create account',
      onSubmit: async v => {
        const r = await AF.db.createUser(Object.assign({ name: v.name, email: v.email }, isSuper ? { role: v.role, tenant_id: tenantId } : {}));
        if (r.ok) { AF.ui.toast('Account created for ' + r.user.name + '.'); if (r.temp_password) tempPasswordDialog(r.user.name, r.temp_password); onDone(); }
        return r;
      },
    });
  }

  function editDialog(u, viewer, onDone) {
    const fields = [{ name: 'name', label: 'Full name', value: u.name, required: true, maxlength: 80 }, { name: 'email', label: 'Email (sign-in ID)', type: 'email', value: u.email, required: true, hint: 'Changing the email signs this person out everywhere.' }];
    if (viewer.role === 'superadmin' && (u.role === 'admin' || u.role === 'employee')) fields.push({ name: 'role', label: 'Role', type: 'select', value: u.role, options: [{ value: 'employee', label: 'Employee' }, { value: 'admin', label: 'Company admin' }] });
    K.formModal({
      title: 'Edit ' + u.name, fields, submitLabel: 'Save changes',
      onSubmit: async v => {
        const patch = {}; ['name', 'email', 'role'].forEach(k => { if (v[k] !== undefined && v[k] !== u[k]) patch[k] = v[k]; });
        if (!Object.keys(patch).length) return { ok: true };
        const r = await AF.db.updateUser(u.id, patch);
        if (r.ok) { AF.ui.toast('Saved changes for ' + r.user.name + '.'); onDone(); }
        return r;
      },
    });
  }

  function resetDialog(u, onDone) {
    K.formModal({
      title: 'Reset password for ' + u.name, intro: 'They are signed out of every device at once. Leave the field empty to generate a temporary password.',
      fields: [{ name: 'password', label: 'New password (optional)', type: 'password', autocomplete: 'new-password', hint: 'At least 8 characters with a letter and a number.' }], submitLabel: 'Reset password',
      onSubmit: async v => {
        const r = await AF.db.resetPassword(u.id, v.password ? { password: v.password } : {});
        if (r.ok) { AF.ui.toast('Password reset for ' + u.name + '.'); if (r.temp_password) tempPasswordDialog(u.name, r.temp_password); onDone(); }
        return r;
      },
    });
  }

  function freezeDialog(u, onDone) {
    K.formModal({
      title: 'Freeze ' + u.name, intro: u.name + ' will be signed out immediately and cannot sign in until you unfreeze the account. Their flows and history stay.',
      fields: [{ name: 'reason', label: 'Reason (optional, saved in the audit log)', maxlength: 200 }], submitLabel: 'Freeze account', danger: true,
      onSubmit: async v => { const r = await AF.db.freezeUser(u.id, { reason: v.reason }); if (r.ok) { AF.ui.toast(u.name + ' is frozen.'); onDone(); } return r; },
    });
  }

  async function unfreeze(u, onDone) {
    const r = await AF.db.unfreezeUser(u.id);
    if (r.ok) { AF.ui.toast(u.name + ' can sign in again.'); onDone(); } else AF.ui.toast(r.error, 'error');
  }

  async function removeAccount(u, onDone) {
    const yes = await K.confirmDialog({ title: 'Delete ' + u.name + '?', message: 'This removes the account and its sign-in history. Flows they created stay and move to another account in the company. This cannot be undone.', confirmLabel: 'Delete account', danger: true, typeToConfirm: u.email });
    if (!yes) return;
    const r = await AF.db.deleteUser(u.id);
    if (r.ok) { AF.ui.toast(u.name + ' was deleted.'); onDone(); } else AF.ui.toast(r.error, 'error');
  }

  async function loginAs(u) {
    const r = await AF.db.startImpersonation({ user_id: u.id });
    if (!r.ok) { AF.ui.toast(r.error || 'Could not sign in as ' + u.name + '.', 'error'); return; }
    location.href = (document.body.dataset.root || '') + AF.auth.homeFor(r.user.role);
  }

  function rowActions(u, viewer, onDone) {
    const sa = viewer.role === 'superadmin'; const self = u.id === viewer.id;
    const canTouch = sa || u.role === 'employee' || self;
    const btn = (label, fn, kind) => el('button', { type: 'button', class: 'btn btn-sm btn-' + (kind || 'secondary'), 'aria-label': label + ' ' + u.name, text: label, on: { click: fn } });
    const out = [];
    const canLoginAs = !AF.ui.impersonation && ((sa && ['admin', 'employee'].includes(u.role)) || (viewer.role === 'admin' && u.role === 'employee' && u.status !== 'frozen' && u.tenant_id === viewer.tenant_id));
    if (canLoginAs) out.push(btn('Login as', () => loginAs(u)));
    if (canTouch) out.push(btn('Edit', () => editDialog(u, viewer, onDone)), btn('Reset password', () => resetDialog(u, onDone)));
    if (!self && u.role !== 'superadmin' && (sa || u.role === 'employee')) {
      out.push(u.status === 'frozen' ? btn('Unfreeze', () => unfreeze(u, onDone)) : btn('Freeze', () => freezeDialog(u, onDone)), btn('Delete', () => removeAccount(u, onDone), 'danger'));
    }
    return el('div', { class: 'actions' }, out);
  }

  function usersTable(users, viewer, onDone, opts) {
    const cols = [
      { label: 'Account', render: u => el('div', {}, el('div', { class: 'cell-strong', text: u.name + (u.id === viewer.id ? ' (you)' : '') }), el('div', { class: 'muted', text: u.email })) },
      { label: 'Role', render: u => K.badge(ROLE_LABEL[u.role] || u.role) },
      { label: 'Status', render: u => K.statusBadge(u.status) },
      { label: 'Devices', render: u => el('span', { text: u.device_count + ' device' + (u.device_count === 1 ? '' : 's') + ' · ' + u.browser_count + ' browser' + (u.browser_count === 1 ? '' : 's') }) },
      { label: 'Last sign-in', render: u => el('span', { class: 'muted', text: u.last_login ? AF.ui.timeAgo(u.last_login) : 'Never' }) },
      { label: 'Actions', render: u => rowActions(u, viewer, onDone) },
    ];
    return K.table(Object.assign({ caption: 'Accounts', columns: cols, rows: users }, opts || {}));
  }

  AF.accounts = { createAccountDialog, usersTable, tempPasswordDialog, ROLE_LABEL };
})(self);
