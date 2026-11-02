'use strict';
(async () => {
  try {
    const who = await api('whoami', null, 'GET');
    $('who').textContent = `Signed in as ${who.id} (${who.roles.join(', ') || 'no role'})`;
  } catch (e) {
    $('who').textContent = '';
  }
})();

$('btnImport').addEventListener('click', async () => {
  const msg = $('s4Msg');
  const file = $('s4File').files[0];
  if (!file) { msg.className = 'msg error'; msg.textContent = 'Choose the extract file first.'; return; }
  msg.className = 'msg'; msg.textContent = 'Importing...';
  try {
    const out = await api('importS4Extract', { fileName: file.name, content: await file.text() });
    state.s4 = out.invoices;
    state.s4Results = [];
    $('btnCheckAll').disabled = false;
    msg.textContent = `${out.count} rows imported from ${file.name}. Press Check all.`;
    renderS4Table();
  } catch (e) {
    msg.className = 'msg error'; msg.textContent = e.message;
  }
});
