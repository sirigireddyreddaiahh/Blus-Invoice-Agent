'use strict';

const ACTIVE_RULE_IDS = ['AP-02', 'AP-03', 'AP-09', 'AP-11'];
const MAX_FILE_BYTES = 10 * 1024 * 1024; // 10 MB

const UNSUPPORTED_FILE_MSG = 'Only PDF, PNG and JPG files are supported.';
const FILE_TOO_LARGE_MSG = 'File is too large. Maximum size is 10 MB.';
const RULES_CHECK_DISCLAIMER = 'Rules check only. Does not prove the invoice is genuine.';
const CHAT_GREETING_MSG = "Hello! I'm Blus Invoice Agent. Upload an invoice and I'll check it for duplicates and split invoices.";
const SIDEBAR_STORAGE_KEY = 'ap_sentinel_sidebar_collapsed';
const WELCOME_SESSION_KEY = 'blus_welcome_dismissed';

const state = {
  user: 'controller',
  roles: ['APClerk', 'APController'],
  welcomeDismissed: false,
  greetingShown: false,
  selectedFile: null,              // Single attached file in composer chip
  pendingReplacementFile: null,    // Held until user confirms replacement
  lastCheckedFile: null,           // Last file sent for checking
  fields: {},
  currentResult: null,
  s4List: [],
  s4Results: [],
  alertsList: [],
  historyList: [],
  activityList: [],
  lastExportCsv: '',
};

const $ = (id) => document.getElementById(id);

function el(tag, text, cls) {
  const node = document.createElement(tag);
  if (text !== undefined && text !== null) node.textContent = text;
  if (cls) node.className = cls;
  return node;
}

function formatMoney(n) {
  if (n === undefined || n === null || n === '') return '-';
  const num = Number(n);
  if (Number.isNaN(num)) return String(n);
  return num.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function shortenFileName(name, maxLen = 20) {
  const s = String(name || '');
  if (s.length <= maxLen) return s;
  return s.slice(0, maxLen - 3) + '...';
}

function getHeaders() {
  return {
    'Content-Type': 'application/json',
    'Accept': 'application/json',
    'X-User-Role': state.roles.join(','),
    'X-User-Id': state.user,
  };
}

async function api(endpoint, body = null, method = 'POST') {
  const opts = { method, headers: getHeaders() };
  if (method === 'POST' && body !== null) {
    opts.body = JSON.stringify(body);
  }
  const r = await fetch('/fraud/' + endpoint, opts);
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    const msg = (data.error && data.error.message) || (`Request failed (${r.status})`);
    throw new Error(msg);
  }
  const val = data.value !== undefined ? data.value : data;
  if (typeof val === 'string') {
    try { return JSON.parse(val); } catch { return val; }
  }
  return val;
}

async function odataGet(entityAndQuery) {
  const r = await fetch('/fraud/' + entityAndQuery, { method: 'GET', headers: getHeaders() });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((data.error && data.error.message) || 'Failed to load data');
  return data.value || [];
}

function setBanner(id, message, type = 'info') {
  const b = $(id);
  if (!b) return;
  if (!message) {
    b.className = 'status-banner hidden';
    b.textContent = '';
    return;
  }
  b.className = `status-banner ${type}`;
  b.textContent = message;
}

// ============================================================================
// 5. SIDEBAR COLLAPSE & MOBILE OVERLAY
// ============================================================================
function setSidebarCollapsed(collapsed) {
  const sidebar = $('appSidebar');
  if (!sidebar) return;
  sidebar.classList.toggle('collapsed', Boolean(collapsed));
  try {
    localStorage.setItem(SIDEBAR_STORAGE_KEY, collapsed ? '1' : '0');
  } catch {}
}

function initSidebarState() {
  const sidebar = $('appSidebar');
  if (!sidebar) return;
  try {
    const saved = localStorage.getItem(SIDEBAR_STORAGE_KEY);
    if (saved === '1') {
      sidebar.classList.add('collapsed');
    }
  } catch {}
}

function closeMobileSidebar() {
  const sidebar = $('appSidebar');
  const backdrop = $('sidebarBackdrop');
  if (sidebar) sidebar.classList.remove('mobile-open');
  if (backdrop) backdrop.classList.add('hidden');
}

if ($('btnSidebarCollapse')) {
  $('btnSidebarCollapse').addEventListener('click', () => {
    const sidebar = $('appSidebar');
    if (!sidebar) return;
    if (window.innerWidth < 768 && sidebar.classList.contains('mobile-open')) {
      closeMobileSidebar();
      return;
    }
    setSidebarCollapsed(!sidebar.classList.contains('collapsed'));
  });
}

if ($('btnMobileMenu')) {
  $('btnMobileMenu').addEventListener('click', () => {
    const sidebar = $('appSidebar');
    const backdrop = $('sidebarBackdrop');
    if (!sidebar) return;
    const willOpen = !sidebar.classList.contains('mobile-open');
    sidebar.classList.toggle('mobile-open', willOpen);
    if (backdrop) backdrop.classList.toggle('hidden', !willOpen);
  });
}

if ($('sidebarBackdrop')) {
  $('sidebarBackdrop').addEventListener('click', closeMobileSidebar);
}

// ============================================================================
// NAVIGATION & ROLE PERMISSIONS
// ============================================================================
function ensureChatGreeting() {
  if (state.greetingShown) return;
  const thread = $('aiChatThread');
  if (!thread) return;
  state.greetingShown = true;
  if (thread.children.length === 0) {
    const greetingNode = el('div', CHAT_GREETING_MSG, 'chat-bubble assistant chat-greeting-message');
    thread.appendChild(greetingNode);
  }
}

function dismissWelcomeScreen(opts = {}) {
  const { immediate = false, targetPage = 'upload', transferText = '', submitTransferred = false, openFilePicker = false } = opts;
  const welcome = $('welcomeScreen');
  const shell = $('appShell');

  if (!state.welcomeDismissed) {
    state.welcomeDismissed = true;
    try {
      sessionStorage.setItem(WELCOME_SESSION_KEY, '1');
    } catch {}
  }

  ensureChatGreeting();

  if (targetPage) {
    switchPage(targetPage);
  }

  const composerInput = $('aiComposerInput');
  if (transferText && composerInput) {
    composerInput.value = transferText;
  }

  if (welcome && !welcome.classList.contains('hidden')) {
    if (immediate) {
      welcome.classList.add('hidden');
    } else {
      welcome.classList.add('welcome-exit');
      if (shell) shell.classList.add('chat-fade-in');
      setTimeout(() => {
        welcome.classList.add('hidden');
      }, 500);
    }
  }

  if (submitTransferred && transferText.trim()) {
    if (composerInput) composerInput.value = '';
    runAiChatCheck(transferText.trim());
  } else if (openFilePicker && $('chatFileInput')) {
    $('chatFileInput').click();
    if (composerInput) composerInput.focus();
  } else if (targetPage === 'upload' && composerInput) {
    composerInput.focus();
    const len = composerInput.value.length;
    try { composerInput.setSelectionRange(len, len); } catch {}
  }
}

function initWelcomeScreen() {
  const welcome = $('welcomeScreen');
  if (!welcome) return;

  let alreadyDismissed = false;
  try {
    alreadyDismissed = sessionStorage.getItem(WELCOME_SESSION_KEY) === '1';
  } catch {}

  if (alreadyDismissed) {
    state.welcomeDismissed = true;
    welcome.classList.add('hidden');
    ensureChatGreeting();
    return;
  }

  // Option Card 1: Upload invoice
  if ($('welcomeCardUpload')) {
    $('welcomeCardUpload').addEventListener('click', () => {
      dismissWelcomeScreen({ targetPage: 'upload', openFilePicker: true });
    });
  }

  // Option Card 2: Check duplicates
  if ($('welcomeCardDuplicates')) {
    $('welcomeCardDuplicates').addEventListener('click', () => {
      dismissWelcomeScreen({ targetPage: 's4' });
    });
  }

  // Option Card 3: Review queue
  if ($('welcomeCardQueue')) {
    $('welcomeCardQueue').addEventListener('click', () => {
      dismissWelcomeScreen({ targetPage: 'alerts' });
    });
  }

  // Start chat button
  if ($('btnWelcomeStartChat')) {
    $('btnWelcomeStartChat').addEventListener('click', () => {
      const askInput = $('welcomeAskInput');
      const text = askInput ? askInput.value : '';
      dismissWelcomeScreen({ targetPage: 'upload', transferText: text, submitTransferred: Boolean(text.trim()) });
    });
  }

  // Typing in the welcome ask box immediately transitions to the chat screen and preserves typed text
  const askInput = $('welcomeAskInput');
  if (askInput) {
    askInput.addEventListener('input', () => {
      if (!state.welcomeDismissed && askInput.value.length > 0) {
        const val = askInput.value;
        askInput.value = '';
        dismissWelcomeScreen({ targetPage: 'upload', transferText: val, submitTransferred: false });
      }
    });
    askInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        const val = askInput.value;
        askInput.value = '';
        dismissWelcomeScreen({ targetPage: 'upload', transferText: val, submitTransferred: true });
      }
    });
  }

  if ($('btnWelcomeAskSend')) {
    $('btnWelcomeAskSend').addEventListener('click', () => {
      const val = askInput ? askInput.value : '';
      if (askInput) askInput.value = '';
      dismissWelcomeScreen({ targetPage: 'upload', transferText: val, submitTransferred: Boolean(val.trim()) });
    });
  }
}

function switchPage(pageId) {
  document.querySelectorAll('.nav-item').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.page === pageId);
  });
  document.querySelectorAll('.page-section').forEach(sec => {
    sec.classList.toggle('active', sec.id === 'page-' + pageId);
  });
  closeMobileSidebar();

  if (pageId === 'alerts') loadAlertsQueue();
  if (pageId === 'history') loadCheckHistory();
  if (pageId === 'activity') loadActivityLog();
}

document.querySelectorAll('.nav-item').forEach(btn => {
  btn.addEventListener('click', () => {
    if (!state.welcomeDismissed) {
      dismissWelcomeScreen({ targetPage: btn.dataset.page });
    } else {
      switchPage(btn.dataset.page);
    }
  });
});

function applyRolePermissions() {
  const isAuditorOnly = state.roles.includes('Auditor') && !state.roles.includes('APClerk') && !state.roles.includes('APController');
  const canUploadOrCheck = state.roles.includes('APClerk') || state.roles.includes('APController');
  const canPost = state.roles.includes('APClerk');
  const canDecide = state.roles.includes('APController');

  const attachPlusBtn = $('btnAttachPlus');
  if (attachPlusBtn) attachPlusBtn.classList.toggle('hidden', !canUploadOrCheck);
  const aiComposer = $('aiComposer');
  if (aiComposer) aiComposer.classList.toggle('hidden', isAuditorOnly);

  const s4ActionRow = $('s4ActionRow');
  if (s4ActionRow) s4ActionRow.classList.toggle('hidden', !canUploadOrCheck);

  document.querySelectorAll('.btn-chat-post-ledger').forEach(btn => {
    btn.classList.toggle('hidden', !canPost);
  });

  const actionHeader = $('alertsActionHeader');
  if (actionHeader) actionHeader.classList.toggle('hidden', !canDecide);
  const roleHint = $('alertsRoleHint');
  if (roleHint) {
    roleHint.textContent = canDecide
      ? 'Signed in with APController authority: decision buttons enabled.'
      : 'Read-only queue view: only APController users can record Clear, Confirm, or Escalate decisions.';
  }

  if ($('page-alerts') && $('page-alerts').classList.contains('active')) {
    renderAlertsTable();
  }
}

// ============================================================================
// 4. FILE ATTACHMENT IN THE COMPOSER ONLY (Chip inside composer bar)
// ============================================================================
function renderComposerFileChip() {
  const chip = $('composerFileChip');
  const nameEl = $('chipFileName');
  if (!chip || !nameEl) return;

  if (!state.selectedFile) {
    chip.classList.add('hidden');
    nameEl.textContent = '';
    return;
  }

  nameEl.textContent = shortenFileName(state.selectedFile.name, 20);
  nameEl.title = state.selectedFile.name;
  chip.classList.remove('hidden');
}

function removeAttachedFile() {
  state.selectedFile = null;
  state.pendingReplacementFile = null;
  if ($('chatFileInput')) $('chatFileInput').value = '';
  if ($('replaceConfirmBar')) $('replaceConfirmBar').classList.add('hidden');
  renderComposerFileChip();
}

if ($('btnRemoveChipFile')) {
  $('btnRemoveChipFile').addEventListener('click', removeAttachedFile);
}

function applyValidatedFile(file) {
  const reader = new FileReader();
  reader.onload = () => {
    const dataUrl = String(reader.result || '');
    const base64 = dataUrl.includes(',') ? dataUrl.split(',')[1] : dataUrl;
    state.selectedFile = {
      name: file.name,
      size: file.size,
      type: file.type,
      base64,
      dataUrl,
    };
    state.pendingReplacementFile = null;
    if ($('replaceConfirmBar')) $('replaceConfirmBar').classList.add('hidden');
    renderComposerFileChip();
  };
  reader.readAsDataURL(file);
}

function selectFileObject(file) {
  if (!state.welcomeDismissed) {
    dismissWelcomeScreen({ immediate: true, targetPage: 'upload' });
  }
  setBanner('chatComposerBanner', '');
  if (!file) return;

  const ext = String(file.name || '').toLowerCase().split('.').pop();
  const allowed = ['pdf', 'png', 'jpg', 'jpeg'];
  if (!allowed.includes(ext)) {
    setBanner('chatComposerBanner', UNSUPPORTED_FILE_MSG, 'error');
    return;
  }

  if (file.size > MAX_FILE_BYTES) {
    setBanner('chatComposerBanner', FILE_TOO_LARGE_MSG, 'error');
    return;
  }

  // Only one file at a time. Picking a second file replaces the first after confirmation.
  if (state.selectedFile) {
    state.pendingReplacementFile = file;
    const bar = $('replaceConfirmBar');
    if ($('replaceConfirmText')) {
      $('replaceConfirmText').textContent =
        `File "${state.selectedFile.name}" is already attached. Confirm before replacing it with "${file.name}"?`;
    }
    if (bar) bar.classList.remove('hidden');
    return;
  }

  applyValidatedFile(file);
}

if ($('btnConfirmReplaceFile')) {
  $('btnConfirmReplaceFile').addEventListener('click', () => {
    if (state.pendingReplacementFile) {
      applyValidatedFile(state.pendingReplacementFile);
    }
  });
}

if ($('btnCancelReplaceFile')) {
  $('btnCancelReplaceFile').addEventListener('click', () => {
    state.pendingReplacementFile = null;
    if ($('chatFileInput')) $('chatFileInput').value = '';
    if ($('replaceConfirmBar')) $('replaceConfirmBar').classList.add('hidden');
  });
}

if ($('btnAttachPlus')) {
  $('btnAttachPlus').addEventListener('click', () => {
    $('chatFileInput').click();
  });
}

if ($('chatFileInput')) {
  $('chatFileInput').addEventListener('change', (e) => {
    const f = e.target.files && e.target.files[0];
    if (f) selectFileObject(f);
  });
}

// ============================================================================
// 6, 8 & 9. MESSAGE ORDER, INVOICE CHECK RESULT & FOLLOW-UP CHAT
// ============================================================================
function toVerdictLabel(status, activeResults = []) {
  const hasReject = status === 'REJECT' || activeResults.some(r => r.tier === 'REJECT');
  if (hasReject) return 'Blocked';
  const hasHold = status === 'HOLD' || activeResults.some(r => r.tier === 'HOLD');
  if (hasHold) return 'Needs review';
  return 'Passed checks';
}

function renderAiChatResultMessage(res, checkedFileName) {
  const allResults = res.results || [];
  const activeRows = (res.activeResults && res.activeResults.length)
    ? res.activeResults
    : allResults.filter(r => ACTIVE_RULE_IDS.includes(r.id));

  const verdict = res.verdict || toVerdictLabel(res.status, activeRows);
  const inv = res.invoice || res.fields || {};

  const msgCard = el('div', null, 'chat-bubble assistant chat-result-message');

  // 8c.1: A verdict badge only: green "Passed checks", amber "Needs review", or red "Blocked"
  const badgeCls = verdict === 'Passed checks'
    ? 'verdict-pass'
    : (verdict === 'Needs review' ? 'verdict-hold' : 'verdict-block');
  const verdictBadge = el('span', verdict, `verdict-badge ${badgeCls}`);
  msgCard.appendChild(verdictBadge);

  // 8c.2: Invoice number, date, supplier name, GSTIN, total. One field per line. No table, no grid.
  const fieldsLines = el('div', null, 'result-fields-lines');
  const fieldItems = [
    `Invoice number: ${inv.invoiceNo || '-'}`,
    `Date: ${inv.invoiceDate || '-'}`,
    `Supplier name: ${inv.supplierName || '-'}`,
    `GSTIN: ${inv.supplierGstin || '-'}`,
    `Total: INR ${inv.total !== undefined ? formatMoney(inv.total) : '-'}`,
  ];
  for (const lineText of fieldItems) {
    fieldsLines.appendChild(el('div', lineText, 'result-field-line'));
  }
  msgCard.appendChild(fieldsLines);

  // 8c.3: Four rule results. One line each: rule ID · result badge · short plain-language reason
  const rulesList = el('div', null, 'chat-active-rules-list');
  for (const r of activeRows) {
    const line = el('div', null, 'chat-rule-line');
    line.append(
      el('span', r.id, 'rule-id'),
      el('span', '·', 'rule-sep'),
      el('span', r.tier, `badge ${r.tier}`),
      el('span', '·', 'rule-sep'),
      el('span', r.text || '', 'rule-reason')
    );
    rulesList.appendChild(line);
  }
  msgCard.appendChild(rulesList);

  // 8c.4: One grey line at the bottom: "Rules check only. Does not prove the invoice is genuine."
  const noteEl = el('div', RULES_CHECK_DISCLAIMER, 'chat-rules-disclaimer');
  msgCard.appendChild(noteEl);

  // 8c.5: Two buttons below: "Post to ledger" and "Save result".
  const actionsRow = el('div', null, 'chat-result-actions');
  const canPostRole = state.roles.includes('APClerk');
  const isBlocked = verdict === 'Blocked' || res.status === 'REJECT';

  const btnPost = el('button', 'Post to ledger', 'primary btn-chat-post-ledger');
  btnPost.type = 'button';
  btnPost.disabled = isBlocked || !canPostRole;
  if (!canPostRole) btnPost.classList.add('hidden');

  const btnSave = el('button', 'Save result', 'btn-chat-save-result');
  btnSave.type = 'button';

  const actionStatusEl = el('div', '', 'status-banner hidden');

  btnPost.addEventListener('click', async () => {
    if (isBlocked) return;
    actionStatusEl.className = 'status-banner info';
    actionStatusEl.textContent = 'Posting invoice to ledger...';
    try {
      const payload = {
        ...state.fields,
        fileName: checkedFileName || inv.invoiceNo,
        source: 'CHAT',
      };
      const out = await api('postInvoice', { invoice: JSON.stringify(payload) });
      if (out.posted) {
        actionStatusEl.className = `status-banner ${out.blocked ? 'warning' : 'success'}`;
        actionStatusEl.textContent = out.blocked
          ? 'Posted to ledger with payment block (HOLD).'
          : 'Successfully posted to ledger (PASS).';
        btnPost.disabled = true;
      } else {
        actionStatusEl.className = 'status-banner error';
        actionStatusEl.textContent = 'Blocked invoices cannot be posted to ledger.';
      }
    } catch (err) {
      actionStatusEl.className = 'status-banner error';
      actionStatusEl.textContent = err.message;
    }
  });

  btnSave.addEventListener('click', async () => {
    actionStatusEl.className = 'status-banner success';
    actionStatusEl.textContent = 'Result saved to check history.';
  });

  actionsRow.append(btnPost, btnSave);
  msgCard.append(actionsRow, actionStatusEl);

  return msgCard;
}

let chatActionQueue = Promise.resolve();

function enqueueChatAction(fn) {
  chatActionQueue = chatActionQueue.then(() => fn()).catch((err) => {
    console.error('Chat action error:', err);
  });
  return chatActionQueue;
}

function scrollChatToBottom() {
  const thread = $('aiChatThread');
  if (!thread) return;
  thread.scrollTop = thread.scrollHeight;
}

function appendMessageToChat(node) {
  const thread = $('aiChatThread');
  if (!thread || !node) return;
  thread.appendChild(node);
  scrollChatToBottom();
}

async function askQuestionInAiThread(questionText, explicitCheckId = '') {
  const q = String(questionText || '').trim();
  if (!q) return;

  // User message on the right, newest at the bottom
  const userBubble = el('div', q, 'chat-bubble user');
  appendMessageToChat(userBubble);

  // Single thinking indicator on the left while server runs
  const replyBubble = el('div', 'Thinking...', 'chat-bubble assistant thinking-indicator');
  appendMessageToChat(replyBubble);

  try {
    const checkId = explicitCheckId || (state.currentResult && state.currentResult.checkId) || '';
    const reply = await api('askInvoice', { checkId, question: q });
    replyBubble.classList.remove('thinking-indicator');
    replyBubble.textContent = typeof reply === 'string' ? reply : JSON.stringify(reply);
  } catch (err) {
    replyBubble.classList.remove('thinking-indicator');
    replyBubble.textContent = err.message || 'The assistant is not configured.';
  }
  scrollChatToBottom();
}

async function performAiChatCheck(userPromptText = '') {
  if (!state.welcomeDismissed) {
    dismissWelcomeScreen({ immediate: true, targetPage: 'upload' });
  }
  setBanner('chatComposerBanner', '');
  const trimmedPrompt = String(userPromptText || '').trim();

  if (state.selectedFile) {
    const fileToSend = state.selectedFile;
    state.lastCheckedFile = fileToSend;

    // 4. The chip disappears after Send is pressed
    state.selectedFile = null;
    if ($('chatFileInput')) $('chatFileInput').value = '';
    renderComposerFileChip();

    // 8a. User message on the right: "Checking [filename]"
    appendMessageToChat(el('div', `Checking ${fileToSend.name}`, 'chat-bubble user'));

    // 8b. A single thinking indicator on the left while the server runs
    const thinkingBubble = el('div', 'Thinking...', 'chat-bubble assistant thinking-indicator');
    appendMessageToChat(thinkingBubble);

    try {
      const out = await api('chatCheckInvoice', {
        fileName: fileToSend.name,
        fileSize: fileToSend.size,
        fileBase64: fileToSend.base64,
      });

      thinkingBubble.remove();
      state.fields = out.fields || {};

      if (out.ok === false) {
        state.currentResult = null;
        appendMessageToChat(
          el('div', out.error || out.warning || 'Image could not be read.', 'chat-bubble assistant')
        );
        return;
      }

      state.currentResult = out;
      const resultMsg = renderAiChatResultMessage(out, fileToSend.name);
      appendMessageToChat(resultMsg);

      if (trimmedPrompt) {
        await askQuestionInAiThread(trimmedPrompt, out.checkId || '');
      }
    } catch (err) {
      thinkingBubble.remove();
      appendMessageToChat(el('div', err.message, 'chat-bubble assistant'));
    }
    return;
  }

  if (!trimmedPrompt) {
    return;
  }

  await askQuestionInAiThread(trimmedPrompt);
}

function runAiChatCheck(userPromptText = '') {
  return enqueueChatAction(() => performAiChatCheck(userPromptText));
}

if ($('btnAiComposerSend')) {
  $('btnAiComposerSend').addEventListener('click', () => {
    const input = $('aiComposerInput');
    const text = input ? input.value.trim() : '';
    if (input) input.value = '';
    runAiChatCheck(text);
  });
}

if ($('aiComposerInput')) {
  $('aiComposerInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      $('btnAiComposerSend').click();
    }
  });
}

// ============================================================================
// S/4HANA EXTRACT PAGE
// ============================================================================
function renderResultCard(container, res, headingPrefix = 'Check Result') {
  if (!container || !res) return;
  container.classList.remove('hidden');
  container.textContent = '';

  const allResults = res.results || [];
  const activeRows = (res.activeResults && res.activeResults.length)
    ? res.activeResults
    : allResults.filter(r => ACTIVE_RULE_IDS.includes(r.id));

  const verdict = res.verdict || toVerdictLabel(res.status, activeRows);
  const header = el('div', `${headingPrefix} — ${verdict} (${res.status})`, 'verdict-badge');
  container.appendChild(header);

  const listWrap = el('div', null, 'chat-active-rules-list');
  listWrap.style.marginTop = '10px';
  for (const r of activeRows) {
    const row = el('div', null, 'chat-rule-line');
    row.append(
      el('span', r.id, 'rule-id'),
      el('span', '·', 'rule-sep'),
      el('span', r.tier, `badge ${r.tier}`),
      el('span', '·', 'rule-sep'),
      el('span', r.text || '', 'rule-reason')
    );
    listWrap.appendChild(row);
  }
  container.appendChild(listWrap);
}

function renderS4Table() {
  const tbody = $('s4TableBody');
  if (!tbody) return;
  tbody.textContent = '';
  state.s4List.forEach(inv => {
    const res = state.s4Results.find(r => r.id === inv.id);
    const tr = document.createElement('tr');
    const activeNonPass = res
      ? (res.activeResults || res.results.filter(x => ACTIVE_RULE_IDS.includes(x.id)))
          .filter(x => x.tier !== 'PASS')
          .map(x => `${x.id}: ${x.text}`)
          .join(' | ')
      : '';

    tr.append(
      el('td', inv.id || '-', 'mono-cell'),
      el('td', inv.supplierName || '-'),
      el('td', inv.supplierGstin || '-', 'mono-cell'),
      el('td', inv.invoiceNo || '-', 'mono-cell'),
      el('td', inv.invoiceDate || '-', 'mono-cell'),
      el('td', formatMoney(inv.total), 'num-col')
    );

    const tdStatus = document.createElement('td');
    if (res) {
      tdStatus.append(el('span', res.status, `badge ${res.status}`));
    } else {
      tdStatus.append(el('span', 'PENDING', 'badge SKIPPED'));
    }
    tr.append(tdStatus, el('td', res ? (activeNonPass || 'All active rules passed') : 'Click "Check all" to evaluate'));

    tr.addEventListener('click', () => {
      if (!res) return;
      renderResultCard($('resultCardS4'), res, `S/4HANA Invoice ${inv.id}`);
    });

    tbody.append(tr);
  });
}

if ($('btnUseSampleS4')) {
  $('btnUseSampleS4').addEventListener('click', async () => {
    setBanner('s4Banner', 'Loading sample S/4HANA extract...', 'info');
    try {
      state.s4List = await api('fetchS4Invoices', null, 'GET');
      state.s4Results = [];
      if ($('resultCardS4')) $('resultCardS4').classList.add('hidden');
      renderS4Table();
      setBanner('s4Banner', `Loaded ${state.s4List.length} invoices from sample S/4HANA extract.`, 'success');
    } catch (err) {
      setBanner('s4Banner', err.message, 'error');
    }
  });
}

if ($('btnImportS4')) {
  $('btnImportS4').addEventListener('click', () => {
    const f = $('s4FileInput') && $('s4FileInput').files && $('s4FileInput').files[0];
    if (!f) {
      setBanner('s4Banner', 'Choose a CSV or JSON extract file first.', 'error');
      return;
    }
    const reader = new FileReader();
    reader.onload = async () => {
      try {
        const out = await api('importS4Extract', { fileName: f.name, content: String(reader.result || '') });
        state.s4List = out.invoices || [];
        state.s4Results = [];
        renderS4Table();
        setBanner('s4Banner', `Imported ${out.count} invoices from ${out.fileName}.`, 'success');
      } catch (err) {
        setBanner('s4Banner', err.message, 'error');
      }
    };
    reader.readAsText(f);
  });
}

if ($('btnCheckAllS4')) {
  $('btnCheckAllS4').addEventListener('click', async () => {
    if (!state.s4List.length) {
      state.s4List = await api('fetchS4Invoices', null, 'GET');
    }
    setBanner('s4Banner', `Running active rules across ${state.s4List.length} invoices...`, 'info');
    try {
      state.s4Results = await api('checkBatch', { invoices: JSON.stringify(state.s4List) });
      renderS4Table();
      if (state.s4Results.length > 0) {
        renderResultCard($('resultCardS4'), state.s4Results[0], `S/4HANA Invoice ${state.s4Results[0].id}`);
      }
      setBanner('s4Banner', `Checked ${state.s4Results.length} S/4HANA invoices.`, 'success');
    } catch (err) {
      setBanner('s4Banner', err.message, 'error');
    }
  });
}

// ============================================================================
// REVIEW QUEUE PAGE
// ============================================================================
async function loadAlertsQueue() {
  try {
    state.alertsList = await odataGet('Alerts?$orderby=createdAt desc');
    renderAlertsTable();
  } catch (err) {
    setBanner('alertsBanner', err.message, 'error');
  }
}

function renderAlertsTable() {
  const tbody = $('alertsTableBody');
  if (!tbody) return;
  tbody.textContent = '';
  const canDecide = state.roles.includes('APController');

  if (!state.alertsList.length) {
    const tr = document.createElement('tr');
    const td = el('td', 'No alerts in the review queue yet.');
    td.colSpan = canDecide ? 6 : 5;
    tr.append(td);
    tbody.append(tr);
    return;
  }

  for (const alert of state.alertsList) {
    const tr = document.createElement('tr');
    tr.append(
      el('td', alert.ruleId),
      el('td', alert.title || '-'),
      el('td', alert.text || '-')
    );
    const tdStatus = document.createElement('td');
    tdStatus.append(el('span', alert.tier, `badge ${alert.tier}`));
    tr.append(tdStatus);

    const tdDec = document.createElement('td');
    tdDec.textContent = alert.decision === 'OPEN'
      ? 'OPEN'
      : `${alert.decision} by ${alert.decidedBy || 'controller'} (${alert.comment || ''})`;
    tr.append(tdDec);

    if (canDecide) {
      const tdActions = document.createElement('td');
      if (alert.decision === 'OPEN') {
        const wrap = el('div', null, 'btn-row');
        wrap.style.marginTop = '0';
        const input = document.createElement('input');
        input.type = 'text';
        input.placeholder = 'Comment (required)';
        input.setAttribute('aria-label', `Comment for alert ${alert.ruleId}`);

        const makeBtn = (label, decision) => {
          const b = el('button', label, decision === 'CONFIRM' ? 'primary' : '');
          b.type = 'button';
          b.addEventListener('click', async () => {
            const comment = input.value.trim();
            if (!comment) {
              setBanner('alertsBanner', 'A comment is required for every decision.', 'error');
              input.focus();
              return;
            }
            try {
              await api('decideAlert', { alertId: alert.ID, decision, comment });
              setBanner('alertsBanner', `Alert ${alert.ruleId} marked as ${decision}.`, 'success');
              await loadAlertsQueue();
            } catch (err) {
              setBanner('alertsBanner', err.message, 'error');
            }
          });
          return b;
        };

        if (alert.tier !== 'REJECT') {
          wrap.append(makeBtn('Clear', 'CLEAR'));
        }
        wrap.append(makeBtn('Confirm', 'CONFIRM'), makeBtn('Escalate', 'ESCALATE'), input);
        tdActions.append(wrap);
      } else {
        tdActions.append(el('span', 'Decision recorded', 'hint'));
      }
      tr.append(tdActions);
    }

    tbody.append(tr);
  }
}

if ($('btnRefreshAlerts')) {
  $('btnRefreshAlerts').addEventListener('click', loadAlertsQueue);
}

// ============================================================================
// CHECK HISTORY PAGE
// ============================================================================
async function loadCheckHistory() {
  try {
    state.historyList = await odataGet('Checks?$orderby=createdAt desc');
    renderHistoryTable();
  } catch (err) {
    console.error(err);
  }
}

function getFilteredHistory() {
  const statusFilter = $('filterHistoryStatus') ? $('filterHistoryStatus').value : 'ALL';
  const fromDate = $('filterHistoryFrom') ? $('filterHistoryFrom').value : '';
  const toDate = $('filterHistoryTo') ? $('filterHistoryTo').value : '';
  const supplierQuery = $('filterHistorySupplier') ? $('filterHistorySupplier').value.trim().toLowerCase() : '';

  return state.historyList.filter(row => {
    if (statusFilter !== 'ALL' && row.status !== statusFilter) return false;
    const rowDate = row.invoiceDate || (row.createdAt ? row.createdAt.slice(0, 10) : '');
    if (fromDate && rowDate && rowDate < fromDate) return false;
    if (toDate && rowDate && rowDate > toDate) return false;
    if (supplierQuery) {
      const hay = `${row.supplierName || ''} ${row.supplierGstin || ''} ${row.invoiceNo || ''}`.toLowerCase();
      if (!hay.includes(supplierQuery)) return false;
    }
    return true;
  });
}

function renderHistoryTable() {
  const tbody = $('historyTableBody');
  if (!tbody) return;
  tbody.textContent = '';
  const rows = getFilteredHistory();

  if (!rows.length) {
    const tr = document.createElement('tr');
    const td = el('td', 'No check records match the current filter.');
    td.colSpan = 7;
    tr.append(td);
    tbody.append(tr);
    return;
  }

  for (const r of rows) {
    const tr = document.createElement('tr');
    const timeStr = r.createdAt ? new Date(r.createdAt).toLocaleString() : '-';
    tr.append(
      el('td', timeStr, 'mono-cell'),
      el('td', r.fileName ? `${r.fileName} (${r.source || 'CHAT'})` : (r.source || '-')),
      el('td', r.invoiceNo || '-', 'mono-cell'),
      el('td', `${r.supplierName || '-'} (${r.supplierGstin || '-'})`),
      el('td', formatMoney(r.total), 'num-col')
    );
    const tdSt = document.createElement('td');
    tdSt.append(el('span', r.status, `badge ${r.status}`));
    tr.append(tdSt, el('td', r.createdBy || 'reviewer'));
    tbody.append(tr);
  }
}

if ($('btnApplyHistoryFilter')) {
  $('btnApplyHistoryFilter').addEventListener('click', renderHistoryTable);
}

function buildHistoryActiveRulesCsv(rows) {
  const headers = [
    'Time',
    'Source',
    'File',
    'Invoice Number',
    'Supplier',
    'Supplier GSTIN',
    'Total (INR)',
    'Status',
    'Reviewer',
    'AP-02 (Exact duplicate)',
    'AP-03 (GSTIN reuse)',
    'AP-09 (Same vendor/amount/services)',
    'AP-11 (Split invoices)',
  ];

  const escapeCsv = (val) => {
    const s = String(val === undefined || val === null ? '' : val);
    if (s.includes(',') || s.includes('"') || s.includes('\n')) {
      return `"${s.replace(/"/g, '""')}"`;
    }
    return s;
  };

  const lines = [headers.map(escapeCsv).join(',')];
  for (const r of rows) {
    let parsed = {};
    try { parsed = JSON.parse(r.resultJson || '{}'); } catch {}
    const results = parsed.results || [];
    const getRuleTier = (id) => {
      const hit = results.find(x => x.id === id);
      return hit ? `${hit.tier}: ${hit.text}` : 'PASS';
    };

    const rowCells = [
      r.createdAt || '',
      r.source || 'CHAT',
      r.fileName || r.source || '',
      r.invoiceNo || '',
      r.supplierName || '',
      r.supplierGstin || '',
      r.total ?? '',
      r.status || '',
      r.createdBy || 'reviewer',
      getRuleTier('AP-02'),
      getRuleTier('AP-03'),
      getRuleTier('AP-09'),
      getRuleTier('AP-11'),
    ];
    lines.push(rowCells.map(escapeCsv).join(','));
  }

  return '\uFEFF' + lines.join('\r\n');
}

function triggerDownload(content, filename, mimeType) {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

if ($('btnExportHistoryCsv')) {
  $('btnExportHistoryCsv').addEventListener('click', () => {
    const csv = buildHistoryActiveRulesCsv(getFilteredHistory());
    state.lastExportCsv = csv;
    window.__lastHistoryExportCsv = csv;
    triggerDownload(csv, 'ap-sentinel-check-history.csv', 'text/csv;charset=utf-8');
  });
}

if ($('btnExportHistoryExcel')) {
  $('btnExportHistoryExcel').addEventListener('click', () => {
    const csv = buildHistoryActiveRulesCsv(getFilteredHistory());
    state.lastExportCsv = csv;
    window.__lastHistoryExportCsv = csv;
    triggerDownload(csv, 'ap-sentinel-check-history-excel.csv', 'application/vnd.ms-excel;charset=utf-8');
  });
}

// ============================================================================
// ACTIVITY LOG PAGE
// ============================================================================
function parseAuditDetail(detailStr) {
  const s = String(detailStr || '');
  const uMatch = s.match(/\[user=([^\]]*)\]/);
  const fMatch = s.match(/\[file=([^\]]*)\]/);
  const rMatch = s.match(/\[result=([^\]]*)\]/);
  const clean = s.replace(/\[(?:user|file|result)=[^\]]*\]/g, '').trim();
  return {
    user: uMatch ? uMatch[1] : 'reviewer',
    file: fMatch ? fMatch[1] : '-',
    result: rMatch ? rMatch[1] : clean,
    clean,
  };
}

async function loadActivityLog() {
  try {
    state.activityList = await odataGet('AuditLog?$orderby=idx desc');
    const chain = await api('verifyAuditChain', null, 'GET');
    const badge = $('auditChainBadge');
    if (badge) {
      if (chain.ok) {
        badge.className = 'status-banner success';
        badge.textContent = `Audit Hash Chain: Verified (${chain.entries} entries intact)`;
      } else {
        badge.className = 'status-banner error';
        badge.textContent = `Audit Hash Chain: Broken at entry #${chain.brokenAt}`;
      }
    }
    renderActivityTable();
  } catch (err) {
    console.error(err);
  }
}

function renderActivityTable() {
  const tbody = $('activityTableBody');
  if (!tbody) return;
  tbody.textContent = '';

  if (!state.activityList.length) {
    const tr = document.createElement('tr');
    const td = el('td', 'No activity log entries recorded yet.');
    td.colSpan = 5;
    tr.append(td);
    tbody.append(tr);
    return;
  }

  for (const row of state.activityList) {
    const parsed = parseAuditDetail(row.detail);
    const tr = document.createElement('tr');
    tr.append(
      el('td', row.ts ? new Date(row.ts).toLocaleString() : '-', 'mono-cell'),
      el('td', parsed.user),
      el('td', parsed.file, 'mono-cell'),
      el('td', row.action, 'mono-cell'),
      el('td', parsed.clean || parsed.result)
    );
    tbody.append(tr);
  }
}

if ($('btnRefreshActivity')) {
  $('btnRefreshActivity').addEventListener('click', loadActivityLog);
}

if ($('btnExportActivityCsv')) {
  $('btnExportActivityCsv').addEventListener('click', () => {
    const headers = ['Time', 'User', 'File', 'Action', 'Result'];
    const escapeCsv = (v) => `"${String(v || '').replace(/"/g, '""')}"`;
    const lines = [headers.join(',')];
    for (const row of state.activityList) {
      const parsed = parseAuditDetail(row.detail);
      lines.push([row.ts, parsed.user, parsed.file, row.action, parsed.clean || parsed.result].map(escapeCsv).join(','));
    }
    triggerDownload('\uFEFF' + lines.join('\r\n'), 'ap-sentinel-activity-log.csv', 'text/csv;charset=utf-8');
  });
}

// ============================================================================
// INITIALIZATION
// ============================================================================
async function initApp() {
  initSidebarState();
  initWelcomeScreen();

  const params = new URLSearchParams(window.location.search);
  const roleParam = params.get('role');
  if (roleParam) {
    state.roles = roleParam.split(',').map(s => s.trim()).filter(Boolean);
    state.user = state.roles[0].toLowerCase();
  } else {
    try {
      const who = await api('whoami', null, 'GET');
      if (who && Array.isArray(who.roles) && who.roles.length) {
        state.roles = who.roles;
        state.user = who.id || 'controller';
      }
    } catch {
      // Keep default controller/clerk role
    }
  }

  applyRolePermissions();
}

initApp();
