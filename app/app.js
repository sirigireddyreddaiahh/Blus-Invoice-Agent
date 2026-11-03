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
  user: 'user',
  roles: ['APClerk', 'APController', 'Auditor'],
  welcomeDismissed: false,
  greetingShown: false,
  selectedFile: null,              // Single attached file in composer chip
  pendingReplacementFile: null,    // Held until user confirms replacement
  lastCheckedFile: null,           // Last file sent for checking
  fields: {},
  currentResult: null,
  s4List: [],
  s4Results: [],
  s4Page: 1,
  s4Limit: 50,
  s4Total: 0,
  s4TotalPages: 1,
  s4Counts: { total: 0, pass: 0, hold: 0, reject: 0 },
  alertsList: [],
  alertsPage: 1,
  alertsLimit: 50,
  alertsTotal: 0,
  alertsTotalPages: 1,
  historyList: [],
  historyPage: 1,
  historyLimit: 50,
  historyTotal: 0,
  historyTotalPages: 1,
  activityList: [],
  activityPage: 1,
  activityLimit: 50,
  activityTotal: 0,
  activityTotalPages: 1,
  lastExportCsv: '',
  currentJobId: null,
  jobPollTimer: null,
  jobErrors: [],
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

function showToast(message, type = 'success', duration = 4500) {
  let container = $('appToastContainer');
  if (!container) {
    container = el('div', null, 'app-toast-container');
    container.id = 'appToastContainer';
    document.body.appendChild(container);
  }
  const toast = el('div', message, `app-toast ${type}`);
  container.appendChild(toast);
  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateY(12px)';
    setTimeout(() => toast.remove(), 320);
  }, duration);
}

function updateS4ProgressUI(job, fallbackTotal = 0) {
  const wrap = $('s4ProgressWrap');
  const bar = $('s4ProgressBar');
  const text = $('s4ProgressText');
  const btnErrors = $('btnViewS4Errors');
  const btnCancel = $('btnCancelS4');
  const btnResume = $('btnResumeS4');

  if (!wrap || !bar || !text) return;
  wrap.classList.remove('hidden');

  const total = job.total || fallbackTotal || (state.s4List ? state.s4List.length : 0) || 1;
  const processed = Math.min(job.processed || 0, total);
  const pct = total > 0 ? Math.min(100, Math.max(0, Math.round((processed / total) * 100))) : 0;

  bar.style.width = `${pct}%`;
  text.textContent = `${processed} of ${total} processed (${pct}%)`;


  // One bad invoice must not stop the chunk: record failed invoices in errorsJson (invoice number, reason),
  // continue with the rest of the chunk, and show a "View errors" link under the progress bar that opens a small list.
  const errors = Array.isArray(job.errors) ? job.errors : [];
  state.jobErrors = errors;
  if (btnErrors) {
    if (errors.length > 0) {
      btnErrors.textContent = `View errors (${errors.length})`;
      btnErrors.classList.remove('hidden');
      renderS4ErrorsList(errors);
    } else {
      btnErrors.classList.add('hidden');
      if ($('s4ErrorsModal')) $('s4ErrorsModal').classList.add('hidden');
    }
  }

  // Button visibility:
  // Cancel button visible ONLY while the job is QUEUED or RUNNING
  // Resume button visible when CANCELLED or FAILED and processed < total
  if (btnCancel && btnResume) {
    if (job.status === 'QUEUED' || job.status === 'RUNNING') {
      btnCancel.classList.remove('hidden');
      btnCancel.disabled = false;
      btnResume.classList.add('hidden');
    } else if (job.status === 'CANCELLED' || job.status === 'FAILED') {
      btnCancel.classList.add('hidden');
      if (processed < total) {
        btnResume.classList.remove('hidden');
        btnResume.disabled = false;
      } else {
        btnResume.classList.add('hidden');
      }
    } else if (job.status === 'DONE') {
      btnCancel.classList.add('hidden');
      btnResume.classList.add('hidden');
    }
  }
}

function renderS4ErrorsList(errors) {
  const list = $('s4ErrorsList');
  if (!list) return;
  list.textContent = '';
  errors.forEach(err => {
    const item = el('div', null, 's4-error-item');
    item.append(
      el('span', err.invoiceNo || 'Invoice', 's4-error-inv'),
      el('span', `— ${err.reason || 'Failed to process'}`)
    );
    list.appendChild(item);
  });
}

function stopJobPolling() {
  if (state.jobPollTimer) {
    clearInterval(state.jobPollTimer);
    state.jobPollTimer = null;
  }
}

async function fetchJobStatus(jobId) {
  try {
    const res = await fetch('/jobs/' + jobId, {
      method: 'GET',
      headers: getHeaders(),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch (err) {
    return null;
  }
}

async function pollBatchJob(jobId, initialTotal = 0) {
  stopJobPolling();
  state.currentJobId = jobId;

  setBanner('s4Banner', 'Processing started', 'info');
  showToast('Processing started', 'info', 2500);

  // Initialize progress bar UI smoothly
  updateS4ProgressUI({
    jobId,
    status: 'QUEUED',
    total: initialTotal,
    processed: 0,
    errors: [],
  }, initialTotal);

  const pollInterval = 2000; // Polling every 2 seconds smoothly without flicker

  const checkStatus = async () => {
    const job = await fetchJobStatus(jobId);
    if (!job) return;

    updateS4ProgressUI(job, initialTotal);
    // Live refreshing partial results with server-side pagination and filters
    loadS4Results(state.s4Page, true);

    if (job.status === 'DONE') {
      stopJobPolling();
      const total = job.total || initialTotal || 0;
      loadS4Results(state.s4Page, true);
      const doneMsg = `Batch check completed: ${total} invoices processed (${job.passCount || 0} passed, ${job.holdCount || 0} held, ${job.rejectCount || 0} blocked).`;
      setBanner('s4Banner', doneMsg, 'success');
      showToast(doneMsg, 'success', 5000);
      return;
    }

    if (job.status === 'CANCELLED') {
      stopJobPolling();
      const n = job.processed || 0;
      const total = job.total || initialTotal || 0;
      loadS4Results(state.s4Page, true);
      const cancelMsg = `Job cancelled. ${n} invoices were processed.`;
      setBanner('s4Banner', `Job cancelled. ${n} of ${total} invoices were processed.`, 'info');
      showToast(cancelMsg, 'info', 5000);
      return;
    }

    if (job.status === 'FAILED') {
      stopJobPolling();
      loadS4Results(state.s4Page, true);
      const errMsg = `Job failed: ${job.error || 'Server error'}. Click Resume to continue.`;
      setBanner('s4Banner', errMsg, 'error');
      showToast(errMsg, 'error', 6000);
      return;
    }
  };

  setTimeout(checkStatus, 150);
  state.jobPollTimer = setInterval(checkStatus, pollInterval);
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
function getOrCreateChatContentInner() {
  const thread = $('aiChatThread');
  if (!thread) return null;
  let inner = $('chatContentInner');
  if (!inner) {
    inner = el('div', null, 'chat-content-inner');
    inner.id = 'chatContentInner';
    thread.appendChild(inner);
  }
  return inner;
}

function ensureChatGreeting() {
  if (state.greetingShown) return;
  const inner = getOrCreateChatContentInner();
  if (!inner) return;
  state.greetingShown = true;
  if (inner.children.length === 0) {
    const greetingNode = el('div', CHAT_GREETING_MSG, 'chat-bubble assistant chat-greeting-message');
    inner.appendChild(greetingNode);
  }
}

function dismissWelcomeScreen(opts = {}) {
  const { immediate = false, targetPage = 'upload', transferText = '', submitTransferred = false, openFilePicker = false } = opts;
  const welcome = $('welcomeScreen');
  const shell = $('appShell');

  if (!state.welcomeDismissed) {
    state.welcomeDismissed = true;
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

  try {
    sessionStorage.removeItem(WELCOME_SESSION_KEY);
  } catch {}

  welcome.classList.remove('hidden', 'welcome-exit');

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

  // Option Card 3: Activity log (visible to all roles: Clerk, Auditor, APController)
  if ($('welcomeCardActivity')) {
    $('welcomeCardActivity').addEventListener('click', () => {
      dismissWelcomeScreen({ targetPage: 'activity' });
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
  if (pageId === 'alerts' && !state.roles.includes('APController')) {
    pageId = 'activity';
  }
  document.querySelectorAll('.nav-item').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.page === pageId);
  });
  document.querySelectorAll('.page-section').forEach(sec => {
    sec.classList.toggle('active', sec.id === 'page-' + pageId);
  });
  closeMobileSidebar();

  if (pageId === 's4' && state.currentJobId) loadS4Results(state.s4Page || 1);
  if (pageId === 'alerts') loadAlertsQueue(state.alertsPage || 1);
  if (pageId === 'history') loadCheckHistory(state.historyPage || 1);
  if (pageId === 'activity') loadActivityLog(state.activityPage || 1);
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

  // Review queue in sidebar is visible to APController only (hidden for Clerk and Auditor)
  const navAlerts = $('nav-alerts');
  if (navAlerts) navAlerts.classList.toggle('hidden', !canDecide);

  // Activity log is visible to all roles (Clerk, Auditor, APController)
  const navActivity = $('nav-activity');
  if (navActivity) navActivity.classList.remove('hidden');
  const welcomeCardActivity = $('welcomeCardActivity');
  if (welcomeCardActivity) welcomeCardActivity.classList.remove('hidden');

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
    if (!canDecide) {
      switchPage('activity');
    } else {
      renderAlertsTable();
    }
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
  // Main label in bold black (#000000), answer value in normal weight.
  // 8c.2: Invoice number, date, supplier name, GSTIN, total, Database match. One field per line. No table, no grid.
  // Main label in bold black (#000000), answer value in normal weight.
  const fieldsLines = el('div', null, 'result-fields-lines');
  const dbMatch = res.databaseMatch || {};
  let dbMatchText = 'Not found in database';
  if (dbMatch.matched && dbMatch.record) {
    const rec = dbMatch.record;
    dbMatchText = `Found in database (${dbMatch.reason}: #${rec.invoiceNo}, ${rec.supplierName}, GSTIN: ${rec.supplierGstin}, Date: ${rec.invoiceDate}, Amount: ${rec.totalFormatted})`;
  } else if (dbMatch.status === 'Found in database') {
    dbMatchText = `Found in database (${dbMatch.reason || 'Matched'})`;
  } else if (dbMatch.status) {
    dbMatchText = dbMatch.status;
  }

  const fieldItems = [
    ['Invoice number:', inv.invoiceNo || '-'],
    ['Date:', inv.invoiceDate || '-'],
    ['Supplier name:', inv.supplierName || '-'],
    ['GSTIN:', inv.supplierGstin || '-'],
    ['Total:', `INR ${inv.total !== undefined ? formatMoney(inv.total) : '-'}`],
    ['Database match:', dbMatchText],
  ];
  for (const [labelText, valueText] of fieldItems) {
    const lineEl = el('div', null, 'result-field-line');
    const labelEl = el('strong', `${labelText} `, 'result-field-label');
    const valEl = el('span', String(valueText), 'result-field-value');
    lineEl.append(labelEl, valEl);
    fieldsLines.appendChild(lineEl);
  }
  msgCard.appendChild(fieldsLines);

  // 8c.3: Four rule results. One line each: rule ID · result badge · short plain-language reason
  const rulesList = el('div', null, 'chat-active-rules-list');
  for (const r of activeRows) {
    const line = el('div', null, 'chat-rule-line');
    line.append(
      el('span', r.tier, `badge ${r.tier}`),
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

function renderFormattedAssistantReply(container, rawText) {
  if (!container) return;
  container.textContent = '';
  const text = String(rawText || '');
  const lines = text.split('\n');

  lines.forEach((line, idx) => {
    if (idx > 0) {
      container.appendChild(document.createTextNode('\n'));
    }
    const trimmed = line.trim();
    if (!trimmed) return;

    // Match "Label: Value" or "• Label: Value" or "- Label: Value"
    const kvMatch = line.match(/^(\s*(?:[•\-*]\s+|\d+\.\s+)?[^:\n]{2,48}:)(\s+.*)$/);
    if (kvMatch) {
      const strongEl = el('strong', kvMatch[1], 'ai-main-label');
      const valEl = el('span', kvMatch[2], 'ai-normal-value');
      container.append(strongEl, valEl);
      return;
    }

    // Match standalone section heading ending with ":"
    if (/^(\s*[^:\n]{3,65}:)\s*$/.test(line)) {
      const strongEl = el('strong', line, 'ai-main-label');
      container.appendChild(strongEl);
      return;
    }

    const spanEl = el('span', line, 'ai-normal-value');
    container.appendChild(spanEl);
  });
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
  const inner = getOrCreateChatContentInner();
  if (!inner || !node) return;
  inner.appendChild(node);
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
    const replyStr = typeof reply === 'string' ? reply : JSON.stringify(reply);
    renderFormattedAssistantReply(replyBubble, replyStr);
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
      el('span', r.tier, `badge ${r.tier}`),
      el('span', r.text || '', 'rule-reason')
    );
    listWrap.appendChild(row);
  }
  container.appendChild(listWrap);
}

function renderPagination(prefix, { page, totalPages, total, limit, onPageChange }) {
  const infoEl = $(prefix + 'PaginationInfo');
  const prevBtn = $(prefix + 'PrevPage');
  const nextBtn = $(prefix + 'NextPage');
  const pagesContainer = $(prefix + 'PageNumbers');

  const start = total === 0 ? 0 : (page - 1) * limit + 1;
  const end = Math.min(page * limit, total);
  if (infoEl) {
    infoEl.textContent = `Showing ${start}-${end} of ${total}`;
  }

  if (prevBtn) {
    prevBtn.disabled = page <= 1 || total === 0;
    prevBtn.onclick = () => {
      if (page > 1) onPageChange(page - 1);
    };
  }
  if (nextBtn) {
    nextBtn.disabled = page >= totalPages || total === 0;
    nextBtn.onclick = () => {
      if (page < totalPages) onPageChange(page + 1);
    };
  }

  if (pagesContainer) {
    pagesContainer.textContent = '';
    if (totalPages <= 1) return;

    let startPage = Math.max(1, page - 2);
    let endPage = Math.min(totalPages, startPage + 4);
    if (endPage - startPage < 4) {
      startPage = Math.max(1, endPage - 4);
    }

    if (startPage > 1) {
      const b1 = el('button', '1', `page-num-btn ${page === 1 ? 'active' : ''}`);
      b1.type = 'button';
      b1.onclick = () => onPageChange(1);
      pagesContainer.appendChild(b1);
      if (startPage > 2) {
        const dots = el('span', '…');
        dots.style.padding = '0 4px';
        dots.style.color = 'var(--text-muted)';
        pagesContainer.appendChild(dots);
      }
    }

    for (let p = startPage; p <= endPage; p++) {
      const btn = el('button', String(p), `page-num-btn ${p === page ? 'active' : ''}`);
      btn.type = 'button';
      btn.onclick = () => onPageChange(p);
      pagesContainer.appendChild(btn);
    }

    if (endPage < totalPages) {
      if (endPage < totalPages - 1) {
        const dots = el('span', '…');
        dots.style.padding = '0 4px';
        dots.style.color = 'var(--text-muted)';
        pagesContainer.appendChild(dots);
      }
      const bLast = el('button', String(totalPages), `page-num-btn ${page === totalPages ? 'active' : ''}`);
      bLast.type = 'button';
      bLast.onclick = () => onPageChange(totalPages);
      pagesContainer.appendChild(bLast);
    }
  }
}

async function loadS4Results(page = 1, isPolling = false) {
  state.s4Page = page;
  const status = $('s4FilterStatus') ? $('s4FilterStatus').value : 'ALL';
  const search = $('s4FilterSearch') ? $('s4FilterSearch').value.trim() : '';

  try {
    const params = new URLSearchParams({
      page: String(page),
      limit: '50',
      status,
      search,
    });
    if (state.currentJobId) {
      params.set('jobId', state.currentJobId);
    }

    const res = await fetch(`/fraud/s4Results?${params.toString()}`, {
      method: 'GET',
      headers: getHeaders(),
    });
    if (!res.ok) return;
    const data = await res.json();
    state.s4Results = data.rows || [];
    state.s4Total = data.total || 0;
    state.s4TotalPages = data.totalPages || 1;
    state.s4Counts = data.counts || { total: 0, pass: 0, hold: 0, reject: 0 };

    if ($('s4CountTotal')) $('s4CountTotal').textContent = state.s4Counts.total;
    if ($('s4CountPass')) $('s4CountPass').textContent = state.s4Counts.pass;
    if ($('s4CountHold')) $('s4CountHold').textContent = state.s4Counts.hold;
    if ($('s4CountReject')) $('s4CountReject').textContent = state.s4Counts.reject;

    renderS4Table();
    renderPagination('s4', {
      page: state.s4Page,
      totalPages: state.s4TotalPages,
      total: state.s4Total,
      limit: 50,
      onPageChange: (p) => loadS4Results(p),
    });
  } catch (err) {
    if (!isPolling) console.error('Failed to load S4 results:', err);
  }
}

function renderS4Table() {
  const tbody = $('s4TableBody');
  if (!tbody) return;
  tbody.textContent = '';

  // If we have server results, render them
  if (state.s4Results && state.s4Results.length > 0) {
    state.s4Results.forEach(r => {
      const tr = document.createElement('tr');
      const tdDbMatch = document.createElement('td');
      const dbMatch = r.databaseMatch;
      if (dbMatch && dbMatch.matched) {
        const pill = el('span', 'Found in database', 'badge REJECT');
        pill.style.display = 'inline-block';
        pill.style.marginBottom = '2px';
        const hint = el('div', dbMatch.reason || 'Matched existing record', 'hint');
        tdDbMatch.append(pill, hint);
      } else {
        const pill = el('span', 'Not found in database', 'badge PASS');
        pill.style.display = 'inline-block';
        pill.style.marginBottom = '2px';
        const hint = el('div', 'No match in ledger', 'hint');
        tdDbMatch.append(pill, hint);
      }

      const tdStatus = document.createElement('td');
      tdStatus.append(el('span', r.status, `badge ${r.status}`));

      tr.append(
        el('td', r.invoiceId || '-', 'mono-cell'),
        el('td', r.supplierName || '-'),
        el('td', r.supplierGstin || '-', 'mono-cell'),
        el('td', r.invoiceNo || '-', 'mono-cell'),
        el('td', r.invoiceDate || '-', 'mono-cell'),
        el('td', formatMoney(r.total), 'num-col'),
        tdDbMatch,
        tdStatus,
        el('td', r.reason || (r.status === 'PASS' ? 'All active rules passed' : '-'))
      );

      tr.addEventListener('click', () => {
        let parsed = null;
        try { parsed = typeof r.resultJson === 'string' ? JSON.parse(r.resultJson) : r.resultJson; } catch {}
        if (parsed) {
          renderResultCard($('resultCardS4'), parsed, `S/4HANA Invoice ${r.invoiceId || r.invoiceNo}`);
        }
      });

      tbody.append(tr);
    });
    return;
  }

  // Pre-check preview if s4List is populated but check hasn't run
  if (state.s4List && state.s4List.length > 0 && !state.currentJobId) {
    const previewRows = state.s4List.slice(0, 50);
    previewRows.forEach(inv => {
      const tr = document.createElement('tr');
      const tdDbMatch = document.createElement('td');
      tdDbMatch.append(el('span', 'Not checked', 'hint'));
      const tdStatus = document.createElement('td');
      tdStatus.append(el('span', 'PENDING', 'badge SKIPPED'));

      tr.append(
        el('td', inv.id || '-', 'mono-cell'),
        el('td', inv.supplierName || '-'),
        el('td', inv.supplierGstin || '-', 'mono-cell'),
        el('td', inv.invoiceNo || '-', 'mono-cell'),
        el('td', inv.invoiceDate || '-', 'mono-cell'),
        el('td', formatMoney(inv.total), 'num-col'),
        tdDbMatch,
        tdStatus,
        el('td', 'Click "Check all" to evaluate')
      );
      tbody.append(tr);
    });
    return;
  }

  const tr = document.createElement('tr');
  const msg = state.currentJobId
    ? 'No invoices match the selected filter.'
    : 'Import extract file(s) or click "Use sample extract" and "Check all" to evaluate.';
  const td = el('td', msg);
  td.colSpan = 9;
  tr.append(td);
  tbody.append(tr);
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
  $('btnImportS4').addEventListener('click', async () => {
    const input = $('s4FileInput');
    const files = input && input.files ? Array.from(input.files) : [];
    if (!files.length) {
      setBanner('s4Banner', 'Choose one or more extract or invoice files first.', 'error');
      return;
    }

    // 8. Size limit check per file (10 MB)
    for (const f of files) {
      if (f.size > 10 * 1024 * 1024) {
        const msg = `File "${f.name}" is too large. Maximum size is 10 MB.`;
        setBanner('s4Banner', msg, 'error');
        showToast(msg, 'error');
        return;
      }
    }

    setBanner('s4Banner', `Reading ${files.length} file(s)...`, 'info');
    try {
      const isDoc = (name) => /\.(pdf|png|jpe?g)$/i.test(name);
      const docFiles = files.filter(f => isDoc(f.name));
      const textFiles = files.filter(f => !isDoc(f.name));

      // Handle PDF/image document batch
      if (docFiles.length > 0 && textFiles.length === 0) {
        if (docFiles.length > 2000) {
          const msg = `This batch has ${docFiles.length} invoices. The maximum per job is 2000. Please split the file.`;
          setBanner('s4Banner', msg, 'error');
          showToast(msg, 'error');
          return;
        }

        // Read one document at a time and free buffer
        const filePayloads = [];
        for (let i = 0; i < docFiles.length; i++) {
          const f = docFiles[i];
          setBanner('s4Banner', `Reading document ${i + 1} of ${docFiles.length}: ${f.name}...`, 'info');
          const base64 = await new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => {
              const res = String(reader.result || '');
              resolve(res.includes(',') ? res.split(',')[1] : res);
            };
            reader.onerror = reject;
            reader.readAsDataURL(f);
          });
          filePayloads.push({ fileName: f.name, fileSize: f.size, fileBase64: base64 });
        }

        setBanner('s4Banner', 'Processing started', 'info');
        const uploadRes = await fetch('/fraud/uploadBatchDocuments', {
          method: 'POST',
          headers: getHeaders(),
          body: JSON.stringify({ files: filePayloads }),
        });
        const job = await uploadRes.json();
        if (!uploadRes.ok) {
          throw new Error((job && job.error && job.error.message) || 'Batch document processing failed');
        }

        if (job && (job.jobId || job.id)) {
          state.currentJobId = job.jobId || job.id;
          pollBatchJob(job.jobId || job.id, job.total || docFiles.length);
        }
        return;
      }

      // Handle CSV/JSON extract files
      const mergedInvoices = [];
      for (const f of files) {
        const text = await f.text();
        const out = await api('importS4Extract', { fileName: f.name, content: text });
        if (out && Array.isArray(out.invoices)) {
          mergedInvoices.push(...out.invoices);
        }
      }

      if (mergedInvoices.length > 2000) {
        const msg = `This batch has ${mergedInvoices.length} invoices. The maximum per job is 2000. Please split the file.`;
        setBanner('s4Banner', msg, 'error');
        showToast(msg, 'error');
        return;
      }

      state.s4List = mergedInvoices;
      state.s4Results = [];
      if ($('resultCardS4')) $('resultCardS4').classList.add('hidden');
      renderS4Table();

      // Immediately create background check job for the imported batch
      setBanner('s4Banner', 'Processing started', 'info');
      const job = await api('checkBatch', { invoices: JSON.stringify(state.s4List) });
      if (job && (job.jobId || job.id)) {
        state.currentJobId = job.jobId || job.id;
        pollBatchJob(job.jobId || job.id, state.s4List.length);
      }
    } catch (err) {
      setBanner('s4Banner', err.message, 'error');
      showToast(err.message, 'error');
    }
  });
}

if ($('btnImportToLedger')) {
  $('btnImportToLedger').addEventListener('click', async () => {
    const input = $('s4FileInput');
    const files = input && input.files ? Array.from(input.files) : [];
    if (!files.length) {
      setBanner('s4Banner', 'Choose one or more CSV or JSON extract files first.', 'error');
      return;
    }
    setBanner('s4Banner', `Importing ${files.length} file(s) into database ledger...`, 'info');
    try {
      let totalImported = 0;
      const fileNames = [];
      for (const f of files) {
        fileNames.push(f.name);
        const text = await f.text();
        const out = await api('importToLedger', { fileName: f.name, content: text });
        totalImported += (out && out.count) || 0;
      }
      setBanner('s4Banner', `Imported ${totalImported} invoices into ledger from ${files.length} file(s) (${fileNames.join(', ')}).`, 'success');
    } catch (err) {
      setBanner('s4Banner', err.message, 'error');
    }
  });
}

async function executeDatabaseSearch() {
  const input = $('inputSearchDb');
  const q = input ? input.value.trim() : '';
  const wrap = $('searchDbWrap');
  const tbody = $('searchDbTableBody');
  setBanner('searchDbBanner', 'Searching database ledger...', 'info');
  try {
    const records = await api('searchDatabase', { query: q });
    if (!tbody || !wrap) return;
    tbody.textContent = '';
    wrap.classList.remove('hidden');

    if (!records.length) {
      const tr = document.createElement('tr');
      const td = el('td', `No database records found matching "${q}".`);
      td.colSpan = 8;
      tr.append(td);
      tbody.append(tr);
      setBanner('searchDbBanner', `0 records found for "${q}".`, 'info');
      return;
    }

    for (const r of records) {
      const tr = document.createElement('tr');
      const isBlocked = Boolean(r.blocked);
      const statusBadge = el('span', isBlocked ? 'Payment Block' : 'Booked', `badge ${isBlocked ? 'HOLD' : 'PASS'}`);
      const tdStatus = document.createElement('td');
      tdStatus.appendChild(statusBadge);

      tr.append(
        el('td', r.invoiceNo || '-', 'mono-cell'),
        el('td', r.supplierName || '-'),
        el('td', r.supplierGstin || '-', 'mono-cell'),
        el('td', r.invoiceDate || '-', 'mono-cell'),
        el('td', formatMoney(r.total), 'num-col'),
        el('td', r.description || '-'),
        tdStatus,
        el('td', r.postedAt ? new Date(r.postedAt).toLocaleString() : '-', 'mono-cell')
      );
      tbody.append(tr);
    }
    setBanner('searchDbBanner', `Found ${records.length} record(s) in database ledger.`, 'success');
  } catch (err) {
    setBanner('searchDbBanner', err.message, 'error');
  }
}

if ($('btnSearchDb')) {
  $('btnSearchDb').addEventListener('click', executeDatabaseSearch);
}

if ($('inputSearchDb')) {
  $('inputSearchDb').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      executeDatabaseSearch();
    }
  });
}

if ($('btnClearSearchDb')) {
  $('btnClearSearchDb').addEventListener('click', () => {
    if ($('inputSearchDb')) $('inputSearchDb').value = '';
    if ($('searchDbWrap')) $('searchDbWrap').classList.add('hidden');
    if ($('searchDbTableBody')) $('searchDbTableBody').textContent = '';
    setBanner('searchDbBanner', '');
  });
}

if ($('btnCheckAllS4')) {
  $('btnCheckAllS4').addEventListener('click', async () => {
    if (!state.s4List.length) {
      state.s4List = await api('fetchS4Invoices', null, 'GET');
      renderS4Table();
    }
    setBanner('s4Banner', 'Processing started', 'info');
    try {
      const job = await api('checkBatch', { invoices: JSON.stringify(state.s4List) });
      if (job && (job.jobId || job.id)) {
        pollBatchJob(job.jobId || job.id, job.total || state.s4List.length);
      } else if (Array.isArray(job)) {
        state.s4Results = job;
        renderS4Table();
        if (state.s4Results.length > 0) {
          renderResultCard($('resultCardS4'), state.s4Results[0], `S/4HANA Invoice ${state.s4Results[0].id}`);
        }
        setBanner('s4Banner', `Checked ${state.s4Results.length} S/4HANA invoices.`, 'success');
        showToast(`Checked ${state.s4Results.length} invoices.`, 'success');
      }
    } catch (err) {
      setBanner('s4Banner', err.message, 'error');
      showToast(err.message, 'error');
    }
  });
}

if ($('btnCancelS4')) {
  $('btnCancelS4').addEventListener('click', async () => {
    if (!state.currentJobId) return;
    try {
      $('btnCancelS4').disabled = true;
      const res = await fetch('/jobs/' + state.currentJobId + '/cancel', {
        method: 'POST',
        headers: getHeaders(),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error((data && data.error && data.error.message) || 'Failed to cancel job');
      }
      stopJobPolling();
      const job = await fetchJobStatus(state.currentJobId);
      if (job) {
        updateS4ProgressUI(job);
        const processed = job.processed || 0;
        const total = job.total || (state.s4List ? state.s4List.length : 0);
        setBanner('s4Banner', `Job cancelled. ${processed} of ${total} invoices were processed.`, 'info');
        showToast(`Job cancelled. ${processed} invoices were processed.`, 'info');
      }
    } catch (err) {
      showToast(err.message, 'error');
      setBanner('s4Banner', err.message, 'error');
      $('btnCancelS4').disabled = false;
    }
  });
}

if ($('btnResumeS4')) {
  $('btnResumeS4').addEventListener('click', async () => {
    if (!state.currentJobId) return;
    try {
      $('btnResumeS4').disabled = true;
      const res = await fetch('/jobs/' + state.currentJobId + '/resume', {
        method: 'POST',
        headers: getHeaders(),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error((data && data.error && data.error.message) || 'Failed to resume job');
      }
      showToast('Processing resumed', 'info');
      setBanner('s4Banner', 'Processing resumed', 'info');
      pollBatchJob(state.currentJobId, data.total);
    } catch (err) {
      $('btnResumeS4').disabled = false;
      showToast(err.message, 'error');
      setBanner('s4Banner', err.message, 'error');
    }
  });
}

if ($('btnViewS4Errors')) {
  $('btnViewS4Errors').addEventListener('click', (e) => {
    e.preventDefault();
    const modal = $('s4ErrorsModal');
    if (modal) modal.classList.toggle('hidden');
  });
}

if ($('btnCloseS4Errors')) {
  $('btnCloseS4Errors').addEventListener('click', () => {
    const modal = $('s4ErrorsModal');
    if (modal) modal.classList.add('hidden');
  });
}

// S/4 Filter & Export Handlers
let s4SearchTimeout = null;
if ($('s4FilterSearch')) {
  $('s4FilterSearch').addEventListener('input', () => {
    clearTimeout(s4SearchTimeout);
    s4SearchTimeout = setTimeout(() => {
      loadS4Results(1);
    }, 300);
  });
}

if ($('s4FilterStatus')) {
  $('s4FilterStatus').addEventListener('change', () => {
    loadS4Results(1);
  });
}

async function downloadS4Csv() {
  const status = $('s4FilterStatus') ? $('s4FilterStatus').value : 'ALL';
  const search = $('s4FilterSearch') ? $('s4FilterSearch').value.trim() : '';
  const r = await fetch('/fraud/exportS4Csv', {
    method: 'POST',
    headers: getHeaders(),
    body: JSON.stringify({ jobId: state.currentJobId, status, search }),
  });
  if (!r.ok) {
    throw new Error(`CSV download failed (${r.status})`);
  }
  const rawText = await r.text();
  const csvWithBom = rawText.startsWith('\uFEFF') ? rawText : '\uFEFF' + rawText;
  triggerDownload(csvWithBom, 's4-extract-check-results.csv', 'text/csv;charset=utf-8');
}

async function downloadS4Excel() {
  const status = $('s4FilterStatus') ? $('s4FilterStatus').value : 'ALL';
  const search = $('s4FilterSearch') ? $('s4FilterSearch').value.trim() : '';
  const r = await fetch('/fraud/exportS4Excel', {
    method: 'POST',
    headers: getHeaders(),
    body: JSON.stringify({ jobId: state.currentJobId, status, search }),
  });
  if (!r.ok) {
    throw new Error(`Excel download failed (${r.status})`);
  }
  const xlsxArrayBuffer = await r.arrayBuffer();
  const xlsxBlob = new Blob([xlsxArrayBuffer], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
  triggerDownload(
    xlsxBlob,
    's4-extract-check-results.xlsx',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  );
}

if ($('btnExportS4Csv')) {
  $('btnExportS4Csv').addEventListener('click', () => {
    downloadS4Csv().catch(err => {
      console.error(err);
      showToast(err.message, 'error');
    });
  });
}

if ($('btnExportS4Excel')) {
  $('btnExportS4Excel').addEventListener('click', () => {
    downloadS4Excel().catch(err => {
      console.error(err);
      showToast(err.message, 'error');
    });
  });
}

// ============================================================================
// REVIEW QUEUE PAGE
// ============================================================================
async function loadAlertsQueue(page = 1) {
  state.alertsPage = page;
  const status = $('filterAlertsStatus') ? $('filterAlertsStatus').value : 'ALL';
  try {
    const params = new URLSearchParams({
      page: String(page),
      limit: '50',
      status,
    });
    const res = await fetch(`/fraud/reviewQueue?${params.toString()}`, {
      method: 'GET',
      headers: getHeaders(),
    });
    if (!res.ok) throw new Error('Failed to load review queue');
    const data = await res.json();
    state.alertsList = data.rows || [];
    state.alertsTotal = data.total || 0;
    state.alertsTotalPages = data.totalPages || 1;
    renderAlertsTable();
    renderPagination('alerts', {
      page: state.alertsPage,
      totalPages: state.alertsTotalPages,
      total: state.alertsTotal,
      limit: 50,
      onPageChange: (p) => loadAlertsQueue(p),
    });
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
    const td = el('td', 'No alerts match the selected status in the review queue.');
    td.colSpan = canDecide ? 8 : 7;
    tr.append(td);
    tbody.append(tr);
    return;
  }

  for (const alert of state.alertsList) {
    const tr = document.createElement('tr');
    const issueLabel = alert.ruleName || alert.title || 'Check exception';
    tr.append(
      el('td', alert.invoiceNo || '-', 'mono-cell'),
      el('td', alert.supplierName || '-'),
      el('td', issueLabel),
      el('td', alert.title || '-'),
      el('td', alert.reason || alert.text || '-')
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
        input.setAttribute('aria-label', `Comment for ${issueLabel}`);

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
              setBanner('alertsBanner', `Alert marked as ${decision}.`, 'success');
              await loadAlertsQueue(state.alertsPage);
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

if ($('filterAlertsStatus')) {
  $('filterAlertsStatus').addEventListener('change', () => {
    loadAlertsQueue(1);
  });
}

if ($('btnRefreshAlerts')) {
  $('btnRefreshAlerts').addEventListener('click', () => {
    loadAlertsQueue(state.alertsPage);
  });
}

// ============================================================================
// CHECK HISTORY PAGE
// ============================================================================
function getHistoryFilterParams() {
  return {
    status: $('filterHistoryStatus') ? $('filterHistoryStatus').value : 'ALL',
    fromDate: $('filterHistoryFrom') ? $('filterHistoryFrom').value : '',
    toDate: $('filterHistoryTo') ? $('filterHistoryTo').value : '',
    supplier: $('filterHistorySupplier') ? $('filterHistorySupplier').value.trim() : '',
  };
}

async function loadCheckHistory(page = 1) {
  state.historyPage = page;
  const limitEl = $('filterHistoryLimit');
  const limit = limitEl ? Number(limitEl.value) || 50 : 50;
  state.historyLimit = limit;

  const filters = getHistoryFilterParams();
  const params = new URLSearchParams({
    page: String(page),
    limit: String(limit),
    status: filters.status || 'ALL',
    fromDate: filters.fromDate || '',
    toDate: filters.toDate || '',
    supplier: filters.supplier || '',
  });

  try {
    const res = await fetch(`/fraud/checkHistory?${params.toString()}`, {
      method: 'GET',
      headers: getHeaders(),
    });
    if (!res.ok) throw new Error('Failed to load check history');
    const data = await res.json();
    state.historyList = data.rows || [];
    state.historyTotal = data.total || 0;
    state.historyTotalPages = data.totalPages || 1;
    renderHistoryTable();
    renderPagination('history', {
      page: state.historyPage,
      totalPages: state.historyTotalPages,
      total: state.historyTotal,
      limit: state.historyLimit,
      onPageChange: (p) => loadCheckHistory(p),
    });
  } catch (err) {
    console.error('Failed to load check history:', err);
  }
}

function renderHistoryTable() {
  const tbody = $('historyTableBody');
  if (!tbody) return;
  tbody.textContent = '';

  if (!state.historyList.length) {
    const tr = document.createElement('tr');
    const td = el('td', 'No check records match the current filter.');
    td.colSpan = 7;
    tr.append(td);
    tbody.append(tr);
    return;
  }

  for (const r of state.historyList) {
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

if ($('filterHistoryLimit')) {
  $('filterHistoryLimit').addEventListener('change', () => {
    loadCheckHistory(1);
  });
}

if ($('btnApplyHistoryFilter')) {
  $('btnApplyHistoryFilter').addEventListener('click', () => {
    loadCheckHistory(1);
  });
}

function triggerDownload(content, filename, mimeType) {
  const blob = content instanceof Blob ? content : new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

async function downloadHistoryCsv() {
  const filters = getHistoryFilterParams();
  const r = await fetch('/fraud/exportHistoryCsv', {
    method: 'POST',
    headers: getHeaders(),
    body: JSON.stringify(filters),
  });
  if (!r.ok) {
    throw new Error(`CSV download failed (${r.status})`);
  }
  const rawText = await r.text();
  const csvWithBom = rawText.startsWith('\uFEFF') ? rawText : '\uFEFF' + rawText;
  state.lastExportCsv = csvWithBom;
  window.__lastHistoryExportCsv = csvWithBom;
  triggerDownload(csvWithBom, 'blus-invoice-agent-check-history.csv', 'text/csv;charset=utf-8');
}

async function downloadHistoryExcel() {
  const filters = getHistoryFilterParams();
  const r = await fetch('/fraud/exportHistoryExcel', {
    method: 'POST',
    headers: getHeaders(),
    body: JSON.stringify(filters),
  });
  if (!r.ok) {
    throw new Error(`Excel download failed (${r.status})`);
  }
  const xlsxArrayBuffer = await r.arrayBuffer();
  const xlsxBlob = new Blob([xlsxArrayBuffer], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
  triggerDownload(
    xlsxBlob,
    'blus-invoice-agent-check-history.xlsx',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  );
}

if ($('btnExportHistoryCsv')) {
  $('btnExportHistoryCsv').addEventListener('click', () => {
    downloadHistoryCsv().catch(err => {
      console.error(err);
      showToast(err.message, 'error');
    });
  });
}

if ($('btnExportHistoryExcel')) {
  $('btnExportHistoryExcel').addEventListener('click', () => {
    downloadHistoryExcel().catch(err => {
      console.error(err);
      showToast(err.message, 'error');
    });
  });
}

// ============================================================================
// ACTIVITY LOG PAGE
// ============================================================================
function parseAuditDetail(detailStr, action = '') {
  const s = String(detailStr || '');
  const uMatch = s.match(/\[user=([^\]]*)\]/);
  const fMatch = s.match(/\[file=([^\]]*)\]/);
  const rMatch = s.match(/\[result=([^\]]*)\]/);
  const clean = s.replace(/\[(?:user|file|result)=[^\]]*\]/g, '').trim();
  let user = uMatch ? uMatch[1] : 'User';
  if (action === 'BATCH_JOB' || !user || user.toLowerCase() === 'user' || user.toLowerCase() === 'reviewer' || user.toLowerCase() === 'single-user') {
    user = 'User';
  }
  return {
    user,
    file: fMatch ? fMatch[1] : '-',
    result: rMatch ? rMatch[1] : clean,
    clean,
  };
}

async function loadActivityLog(page = 1) {
  state.activityPage = page;
  const action = $('filterActivityAction') ? $('filterActivityAction').value : 'ALL';

  try {
    const params = new URLSearchParams({
      page: String(page),
      limit: '50',
      action: action || 'ALL',
    });
    const [logRes, chain] = await Promise.all([
      fetch(`/fraud/activityLogs?${params.toString()}`, { method: 'GET', headers: getHeaders() }),
      api('verifyAuditChain', null, 'GET'),
    ]);

    if (logRes.ok) {
      const data = await logRes.json();
      state.activityList = data.rows || [];
      state.activityTotal = data.total || 0;
      state.activityTotalPages = data.totalPages || 1;
      renderActivityTable();
      renderPagination('activity', {
        page: state.activityPage,
        totalPages: state.activityTotalPages,
        total: state.activityTotal,
        limit: 50,
        onPageChange: (p) => loadActivityLog(p),
      });
    }

    const badge = $('auditChainBadge');
    if (badge && chain) {
      if (chain.ok) {
        badge.className = 'status-banner success';
        const countStr = chain.entries === 1 ? '1 entry intact' : `${chain.entries} entries intact`;
        badge.textContent = `Audit Hash Chain: Verified (${countStr})`;
      } else {
        badge.className = 'status-banner error';
        badge.textContent = `Audit Hash Chain: Broken at entry #${chain.brokenAt}`;
      }
    }
  } catch (err) {
    console.error('Failed to load activity log:', err);
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
    const parsed = parseAuditDetail(row.detail, row.action);
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

if ($('filterActivityAction')) {
  $('filterActivityAction').addEventListener('change', () => {
    loadActivityLog(1);
  });
}

if ($('btnRefreshActivity')) {
  $('btnRefreshActivity').addEventListener('click', () => {
    loadActivityLog(state.activityPage);
  });
}

if ($('btnExportActivityCsv')) {
  $('btnExportActivityCsv').addEventListener('click', () => {
    const headers = ['Time', 'User', 'File', 'Action', 'Result'];
    const escapeCsv = (v) => `"${String(v || '').replace(/"/g, '""')}"`;
    const lines = [headers.join(',')];
    for (const row of state.activityList) {
      const parsed = parseAuditDetail(row.detail, row.action);
      lines.push([row.ts, parsed.user, parsed.file, row.action, parsed.clean || parsed.result].map(escapeCsv).join(','));
    }
    triggerDownload('\uFEFF' + lines.join('\r\n'), 'blus-invoice-agent-activity-log.csv', 'text/csv;charset=utf-8');
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
    // Single user mode: all roles granted, full access to all 5 tabs and actions
    state.roles = ['APClerk', 'APController', 'Auditor'];
    state.user = 'user';
  }

  applyRolePermissions();
}

initApp();
