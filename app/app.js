'use strict';

const ACTIVE_RULE_IDS = ['AP-02', 'AP-03', 'AP-09', 'AP-11'];
const MAX_FILE_BYTES = 10 * 1024 * 1024; // 10 MB

const UNSUPPORTED_FILE_MSG = 'Only PDF, PNG and JPG files are supported.';
const FILE_TOO_LARGE_MSG = 'File is too large. Maximum size is 10 MB.';
const RULES_CHECK_DISCLAIMER = 'Rules check only. Does not prove the invoice is genuine.';
const CHAT_GREETING_MSG = "Hello! I'm Blus Invoice Agent. Upload an invoice and I'll check it for duplicates and split invoices.";
const SIDEBAR_STORAGE_KEY = 'ap_sentinel_sidebar_collapsed';
const WELCOME_SESSION_KEY = 'blus_welcome_dismissed';

const TERM_MEANINGS = {
  PASS: 'Passed all checks. Can be saved to the ledger.',
  HOLD: 'Needs a review. Not saved to the ledger until cleared.',
  REJECT: 'Duplicate or split pattern found. Not saved to the ledger until reviewed.',
  INCOMPLETE: 'Required details are missing.',
  'NOT AN INVOICE': 'This is not a supplier invoice.',
  'COULD NOT READ': 'The file could not be read.',
};

const PLAIN_RULE_NAMES = {
  'AP-02': 'Duplicate check',
  'AP-03': 'GSTIN check',
  'AP-09': 'Repeat bill check',
  'AP-11': 'Split invoice check',
};

function cleanReasonDisplayText(rawText) {
  let s = String(rawText || '')
    .replace(/\s*·?\s*SAP sandbox \(demo data\)/gi, '')
    .replace(/\b(sandbox|demo data)\b/gi, '')
    .trim();
  if (!s) return '—';

  // Convert legacy duplicate reason with repeated invoice number to Part 4.1 format
  s = s.replace(
    /Invoice\s+([^\s]+)\s+for\s+GSTIN\s+[^\s]+\s+in\s+FY\s+([^\s]+)\s+matches\s+already-posted\s+([^\s]+)\s+\(dated\s+([^,)]+)(?:,\s*INR\s*[^)]+)?\)\.?/gi,
    'Duplicate of invoice $3 from the same supplier, same financial year ($2), dated $4.'
  );

  // Replace rule codes with plain names
  s = s
    .replace(/\bAP-02\s*\([^)]*\)/gi, PLAIN_RULE_NAMES['AP-02'])
    .replace(/\bAP-03\s*\([^)]*\)/gi, PLAIN_RULE_NAMES['AP-03'])
    .replace(/\bAP-09\s*\([^)]*\)/gi, PLAIN_RULE_NAMES['AP-09'])
    .replace(/\bAP-11\s*\([^)]*\)/gi, PLAIN_RULE_NAMES['AP-11'])
    .replace(/\bAP-02\b/gi, PLAIN_RULE_NAMES['AP-02'])
    .replace(/\bAP-03\b/gi, PLAIN_RULE_NAMES['AP-03'])
    .replace(/\bAP-09\b/gi, PLAIN_RULE_NAMES['AP-09'])
    .replace(/\bAP-11\b/gi, PLAIN_RULE_NAMES['AP-11'])
    .replace(/\bBlocked\b/gi, 'REJECT');

  // Remove trailing dots and "...." characters
  s = s.replace(/\.{2,}/g, '.').replace(/…+/g, '').trim();
  s = s.replace(/\s+\./g, '.');
  return formatCellValue(s);
}

function toDisplayStatusTerm(res, verdict, hasNoInvoiceData = false) {
  const st = String((res && res.status) || '').trim();
  const vd = String(verdict || (res && res.verdict) || '').trim();
  const expl = String((res && (res.explanation || res.reason)) || '').trim();

  if (st === 'Failed to read' || st === 'COULD_NOT_READ' || /^could not read$/i.test(vd) || /no readable text/i.test(expl)) {
    return 'COULD NOT READ';
  }
  if (st === 'NOT_AN_INVOICE' || /^not an invoice$/i.test(vd) || /not a supplier invoice/i.test(expl)) {
    return 'NOT AN INVOICE';
  }
  if (st === 'INCOMPLETE' || /^incomplete/i.test(vd) || hasNoInvoiceData || /missing/i.test(expl) || /this invoice has no data/i.test(expl)) {
    return 'INCOMPLETE';
  }
  if (st === 'HOLD' || /^needs review$/i.test(vd)) {
    return 'HOLD';
  }
  if (st === 'REJECT' || /^blocked$/i.test(vd) || /^reject/i.test(vd)) {
    return 'REJECT';
  }
  return 'PASS';
}

function formatIST(value, withTime = true) {
  if (!value) return '—';
  const d = new Date(value);
  if (isNaN(d.getTime())) return String(value);
  const opts = { timeZone: 'Asia/Kolkata', day: '2-digit', month: '2-digit', year: 'numeric' };
  if (withTime) {
    Object.assign(opts, { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
    return d.toLocaleString('en-IN', opts);
  }
  return d.toLocaleDateString('en-IN', opts);
}

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
  activityView: 'CHECKS',
  historyCounts: { total: 0, pass: 0, hold: 0, reject: 0 },
  alertsCounts: { open: 0, hold: 0, reject: 0 },
  activeReviewAlert: null,
  sapSampleFetched: false,
  lastExportCsv: '',
  currentJobId: null,
  jobPollTimer: null,
  jobErrors: [],
  ledgerList: [],
  ledgerPage: 1,
  ledgerLimit: 50,
  ledgerTotal: 0,
  ledgerTotalPages: 1,
  topSummary: {
    uploaded: 0,
    savedToLedger: 0,
    passed: 0,
    held: 0,
    rejected: 0,
    failedToRead: 0,
    failedFiles: [],
    consistent: true,
    consistencyWarning: null,
  },
};

const $ = (id) => document.getElementById(id);

function el(tag, text, cls) {
  const node = document.createElement(tag);
  if (text !== undefined && text !== null) node.textContent = text;
  if (cls) node.className = cls;
  return node;
}

function formatCellValue(v) {
  if (v === undefined || v === null) return '—';
  const s = String(v).trim();
  if (!s || s === '-' || s === 'undefined' || s === 'null' || s === 'NaN') return '—';
  return s;
}

function formatMoney(n) {
  if (n === undefined || n === null || n === '' || n === '-' || n === '—') return '—';
  const num = Number(n);
  if (Number.isNaN(num)) return '—';
  return num.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function formatReviewerName(v) {
  const s = String(v || '').trim();
  if (!s) return 'System';
  const lower = s.toLowerCase();
  const rawSystemIds = new Set([
    'apclerk',
    'clerk',
    'controller',
    'apcontroller',
    'auditor',
    'reviewer',
    'single-user',
    'user',
    'system',
    'anonymous',
  ]);
  if (rawSystemIds.has(lower)) return 'System';
  return s;
}

function formatActionPlainWord(action) {
  const code = String(action || '').trim().toUpperCase();
  const map = {
    CHECK: 'Check',
    CHAT_CHECK: 'Check',
    IMPORT: 'Import',
    LEDGER_IMPORT: 'Import',
    LEDGER_INSERT: 'Ledger entry',
    POST: 'Ledger entry',
    POST_BLOCKED: 'Ledger entry',
    DATABASE_CHECK: 'Database check',
    DATABASE_SEARCH: 'Database check',
    BATCH_JOB: 'Batch job',
    SAP_FETCH: 'SAP fetch',
    DECISION: 'Decision',
    READ_FAILED: 'Failed to read',
  };
  return map[code] || formatCellValue(action);
}

function formatLedgerMatchPlain(dbMatch) {
  const dm = dbMatch || {};
  if (dm.matched || dm.status === 'Found in database') {
    const rawReason = String(dm.reason || 'same invoice number')
      .replace(/sandbox|demo data/gi, '')
      .trim();
    const cleanReason = rawReason ? rawReason.charAt(0).toLowerCase() + rawReason.slice(1) : 'same invoice number';
    return `Found in ledger: ${cleanReason}`;
  }
  return 'Not found in ledger';
}

function formatSapMatchPlain(sapMatch) {
  const sm = sapMatch || {};
  if (sm.matched || sm.status === 'Found in SAP') {
    return 'Found in SAP';
  }
  if (sm.status === 'Not found in SAP') {
    return 'Not found in SAP';
  }
  if (sm.status === 'SAP unavailable') {
    return 'SAP unavailable';
  }
  return 'Live SAP not configured';
}

function createClampedReasonCell(rawReason) {
  const td = document.createElement('td');
  td.className = 'reason-cell-wrap';
  const cleanText = cleanReasonDisplayText(rawReason);
  const textDiv = el('div', cleanText, 'reason-text clamped');
  td.appendChild(textDiv);

  if (cleanText !== '—' && cleanText.length > 40) {
    const toggleBtn = el('button', 'Show more', 'reason-toggle-btn');
    toggleBtn.type = 'button';
    toggleBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const isClamped = textDiv.classList.toggle('clamped');
      toggleBtn.textContent = isClamped ? 'Show more' : 'Show less';
    });
    td.appendChild(toggleBtn);
  }
  return td;
}

function clearTableGrandTotal(tbodyOrTable) {
  if (!tbodyOrTable) return;
  const table = tbodyOrTable.tagName === 'TABLE' ? tbodyOrTable : tbodyOrTable.closest('table');
  if (!table) return;
  const oldFoot = table.querySelector('tfoot.table-grand-total-foot');
  if (oldFoot) oldFoot.remove();
}

function renderTableGrandTotal(tbodyOrTable, opts = {}) {
  if (!tbodyOrTable) return;
  const table = tbodyOrTable.tagName === 'TABLE' ? tbodyOrTable : tbodyOrTable.closest('table');
  if (!table) return;
  clearTableGrandTotal(table);

  const {
    totalCols = 6,
    amountColIndex = -1,
    totalAmount = null,
    label = 'Grand Total',
    trailingText = '',
  } = opts;

  const tfoot = document.createElement('tfoot');
  tfoot.className = 'table-grand-total-foot';
  const tr = document.createElement('tr');
  tr.className = 'grand-total-row';

  if (amountColIndex >= 0 && totalAmount !== null && !Number.isNaN(Number(totalAmount))) {
    const tdLabel = el('td', label);
    if (amountColIndex > 0) {
      tdLabel.colSpan = amountColIndex;
    }
    const tdAmount = el('td', formatMoney(totalAmount), 'num-col');
    tr.append(tdLabel, tdAmount);

    const remainingCols = totalCols - amountColIndex - 1;
    if (remainingCols > 0) {
      const tdTrail = el('td', trailingText);
      tdTrail.colSpan = remainingCols;
      tr.appendChild(tdTrail);
    }
  } else {
    const tdLabel = el('td', label);
    if (totalCols > 1) {
      tdLabel.colSpan = totalCols - 1;
    }
    const tdVal = el('td', trailingText, 'num-col');
    tr.append(tdLabel, tdVal);
  }

  tfoot.appendChild(tr);
  table.appendChild(tfoot);
}

function renderTableSkeleton(tbody, colCount, rowCount = 5) {
  if (!tbody) return;
  clearTableGrandTotal(tbody);
  tbody.textContent = '';
  for (let r = 0; r < rowCount; r++) {
    const tr = document.createElement('tr');
    for (let c = 0; c < colCount; c++) {
      const td = document.createElement('td');
      const bar = el('div', '', 'skeleton-bar');
      bar.style.width = `${60 + ((r + c) % 4) * 10}%`;
      td.appendChild(bar);
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  }
}

function renderEmptyTableState(tbody, colCount, message, actionLabel = '', onAction = null) {
  if (!tbody) return;
  clearTableGrandTotal(tbody);
  tbody.textContent = '';
  const tr = document.createElement('tr');
  const td = document.createElement('td');
  td.colSpan = colCount;
  const wrap = el('div', null, 'empty-table-state');
  wrap.appendChild(el('p', message, 'empty-table-text'));
  if (actionLabel && typeof onAction === 'function') {
    const btn = el('button', actionLabel, 'primary');
    btn.type = 'button';
    btn.addEventListener('click', onAction);
    wrap.appendChild(btn);
  }
  td.appendChild(wrap);
  tr.appendChild(td);
  tbody.appendChild(tr);
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

async function parseJsonResponse(res) {
  if (!res) return null;
  try {
    const contentType = (res.headers && typeof res.headers.get === 'function') ? (res.headers.get('content-type') || '') : '';
    if (contentType && !contentType.includes('application/json')) {
      return null;
    }
    const text = await res.text();
    if (!text || typeof text !== 'string') return null;
    const trimmed = text.trim();
    if (trimmed.startsWith('<') || (!trimmed.startsWith('{') && !trimmed.startsWith('['))) {
      return null;
    }
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

async function api(endpoint, body = null, method = 'POST') {
  const opts = { method, headers: getHeaders() };
  if (method === 'POST' && body !== null) {
    opts.body = JSON.stringify(body);
  }
  const r = await fetch('/fraud/' + endpoint, opts);
  let data = {};
  try {
    const text = await r.text();
    if (text) {
      const trimmed = text.trim();
      if (!trimmed.startsWith('<') && (trimmed.startsWith('{') || trimmed.startsWith('['))) {
        data = JSON.parse(trimmed);
      }
    }
  } catch {}
  if (!r.ok) {
    const msg = (data && data.error && data.error.message) || (`Request failed (${r.status})`);
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
  const data = (await parseJsonResponse(r)) || {};
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
  text.textContent = `Processing ${processed} of ${total} (${pct}%)`;


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
    return await parseJsonResponse(res);
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
    loadTopSummary();

    if (job.status === 'DONE') {
      stopJobPolling();
      const total = job.total || initialTotal || 0;
      loadS4Results(state.s4Page, true);
      loadTopSummary();
      const doneMsg = `Batch check completed: ${total} invoices processed (${job.passCount || 0} passed, ${job.holdCount || 0} held, ${job.rejectCount || 0} rejected).`;
      setBanner('s4Banner', doneMsg, 'success');
      showToast(doneMsg, 'success', 5000);
      return;
    }

    if (job.status === 'CANCELLED') {
      stopJobPolling();
      const n = job.processed || 0;
      const total = job.total || initialTotal || 0;
      loadS4Results(state.s4Page, true);
      loadTopSummary();
      const cancelMsg = `Job cancelled. ${n} invoices were processed.`;
      setBanner('s4Banner', `Job cancelled. ${n} of ${total} invoices were processed.`, 'info');
      showToast(cancelMsg, 'info', 5000);
      return;
    }

    if (job.status === 'FAILED') {
      stopJobPolling();
      loadS4Results(state.s4Page, true);
      loadTopSummary();
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
    inner.classList.add('empty-chat-state');
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
        if (shell) shell.classList.remove('chat-fade-in');
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

  if (pageId === 'upload') {
    loadTopSummary();
  }
  if (pageId === 's4') {
    loadTopSummary();
    if (state.currentJobId) loadS4Results(state.s4Page || 1);
    else renderS4Table();
  }
  if (pageId === 'ledger') loadLedgerView(state.ledgerPage || 1);
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
    roleHint.textContent = '';
    roleHint.classList.add('hidden');
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
  const ext = String(file.name || '').toLowerCase().split('.').pop();
  const isTextExtract = ext === 'csv' || ext === 'json';
  const reader = new FileReader();
  reader.onload = async () => {
    const dataUrl = String(reader.result || '');
    const base64 = dataUrl.includes(',') ? dataUrl.split(',')[1] : dataUrl;
    let rawText = '';
    if (isTextExtract) {
      try {
        rawText = await file.text();
      } catch {}
    }
    state.selectedFile = {
      name: file.name,
      size: file.size,
      type: file.type,
      ext,
      rawText,
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
  const allowed = ['pdf', 'png', 'jpg', 'jpeg', 'csv', 'json'];
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
  if (status === 'Failed to read' || status === 'COULD_NOT_READ' || status === 'INCOMPLETE' || status === 'NOT_AN_INVOICE') {
    return 'Blocked';
  }
  const hasReject = status === 'REJECT' || activeResults.some(r => r.tier === 'REJECT');
  if (hasReject) return 'Blocked';
  const hasHold = status === 'HOLD' || activeResults.some(r => r.tier === 'HOLD');
  if (hasHold) return 'Needs review';
  if (status && status !== 'PASS') return 'Blocked';
  return 'Passed checks';
}

function renderAiChatResultMessage(res, checkedFileName) {
  const allResults = res.results || [];
  let activeRows = (res.activeResults && res.activeResults.length)
    ? [...res.activeResults]
    : allResults.filter(r => ACTIVE_RULE_IDS.includes(r.id));

  const inv = res.invoice || res.fields || {};
  const hasInvoiceNo = Boolean(inv.invoiceNo && String(inv.invoiceNo).trim() && String(inv.invoiceNo).trim() !== '—');
  const hasSupplierName = Boolean(inv.supplierName && String(inv.supplierName).trim() && String(inv.supplierName).trim() !== '—');
  const hasTotal = inv.total !== undefined && inv.total !== null && inv.total !== '' && !Number.isNaN(Number(inv.total));
  const hasNoInvoiceData = !hasInvoiceNo || !hasSupplierName || !hasTotal || res.ok === false || res.status === 'Failed to read' || res.status === 'INCOMPLETE';

  if (hasNoInvoiceData) {
    const hasNoDataRow = activeRows.some(r => r && r.text && /this invoice (has|have) no data/i.test(r.text));
    if (!hasNoDataRow) {
      activeRows = [
        { id: 'DATA', title: 'Invoice data check', tier: 'REJECT', text: 'This invoice has no data' },
        ...activeRows,
      ];
    }
  } else if (activeRows.length === 0 && (res.explanation || res.reason) && res.status !== 'PASS') {
    activeRows = [
      {
        id: 'CHECK',
        title: 'Document check',
        tier: res.status === 'HOLD' ? 'HOLD' : 'REJECT',
        text: res.explanation || res.reason,
      },
    ];
  }

  let verdict = hasNoInvoiceData ? 'Blocked' : (res.verdict || toVerdictLabel(res.status, activeRows));
  const displayTerm = toDisplayStatusTerm(res, verdict, hasNoInvoiceData);
  const displayMeaning = TERM_MEANINGS[displayTerm] || '';

  const msgCard = el('div', null, 'chat-bubble assistant chat-result-message');

  // PART 1: Display PASS, HOLD, REJECT, INCOMPLETE, NOT AN INVOICE, or COULD NOT READ (never "Blocked")
  const badgeCls = displayTerm === 'PASS'
    ? 'verdict-pass'
    : (displayTerm === 'HOLD' ? 'verdict-hold' : 'verdict-block');
  const badgeDisplayLabel = hasNoInvoiceData
    ? `${displayTerm} — This invoice has no data`
    : (displayMeaning ? `${displayTerm} — ${displayMeaning}` : displayTerm);
  const verdictBadge = el('span', badgeDisplayLabel, `verdict-badge ${badgeCls}`);
  msgCard.appendChild(verdictBadge);

  // 8c.2: Invoice number, date, supplier name, GSTIN, total, Database match. One field per line. No table, no grid.
  // Main label in bold black (#000000), answer value in normal weight.
  const fieldsLines = el('div', null, 'result-fields-lines');
  const dbMatch = res.databaseMatch || {};
  const dbMatchText = formatLedgerMatchPlain(dbMatch);

  const fieldItems = [
    ['Invoice number:', formatCellValue(inv.invoiceNo)],
    ['Date:', formatCellValue(inv.invoiceDate || inv.PostingDate || inv.postingDate)],
    ['Supplier name:', formatCellValue(inv.supplierName)],
    ['GSTIN:', formatCellValue(inv.supplierGstin)],
    ['Total:', inv.total !== undefined && inv.total !== null && inv.total !== '' ? `INR ${formatMoney(inv.total)}` : '—'],
    ['In ledger:', dbMatchText],
  ];
  if (res.aiAssistUsed || res.aiAssistLabel === 'Read with AI assist' || res.warning === 'Read with AI assist') {
    fieldItems.push(['Read status:', 'Read with AI assist']);
  }
  for (const [labelText, valueText] of fieldItems) {
    const lineEl = el('div', null, 'result-field-line');
    const labelEl = el('strong', `${labelText} `, 'result-field-label');
    const valEl = el('span', String(valueText), 'result-field-value');
    lineEl.append(labelEl, valEl);
    fieldsLines.appendChild(lineEl);
  }
  msgCard.appendChild(fieldsLines);

  // 8c.3: Rule results. One line each: result badge · short plain-language reason (no rule codes or Blocked)
  const rulesList = el('div', null, 'chat-active-rules-list');
  for (const r of activeRows) {
    const line = el('div', null, 'chat-rule-line');
    const ruleLabel = PLAIN_RULE_NAMES[r.id] ? `${PLAIN_RULE_NAMES[r.id]}: ` : '';
    const cleanedRuleReason = cleanReasonDisplayText(r.text || '');
    line.append(
      el('span', r.tier || 'REJECT', `badge ${r.tier || 'REJECT'}`),
      el('span', `${ruleLabel}${cleanedRuleReason}`, 'rule-reason')
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
  const isBlocked = verdict === 'Blocked' || res.status === 'REJECT' || hasNoInvoiceData || res.status === 'NOT_AN_INVOICE';
  const isPass = !hasNoInvoiceData && !isBlocked && (verdict === 'Passed checks' || res.status === 'PASS');
  const isHoldOrReject = isBlocked || res.status === 'HOLD' || verdict === 'Needs review';

  const isAlreadyInLedger = Boolean(
    res.alreadyInLedger ||
    (dbMatch.matched && dbMatch.reason === 'Same invoice number')
  );

  const btnPost = el('button', 'Post to ledger', 'primary btn-chat-post-ledger');
  btnPost.type = 'button';
  btnPost.disabled = isBlocked || !canPostRole;

  if (isAlreadyInLedger) {
    btnPost.textContent = 'Saved in ledger';
    btnPost.disabled = true;
  } else if (isHoldOrReject || !isPass) {
    btnPost.textContent = 'Post unavailable';
    btnPost.disabled = true;
  } else if (isPass) {
    btnPost.textContent = 'Post to ledger';
    btnPost.disabled = !canPostRole;
  }

  if (!canPostRole) btnPost.classList.add('hidden');

  const btnSave = el('button', 'Save result', 'btn-chat-save-result');
  btnSave.type = 'button';

  actionsRow.append(btnPost, btnSave);
  msgCard.appendChild(actionsRow);

  if (isAlreadyInLedger) {
    const dupLine = el(
      'div',
      'This invoice is already saved in the ledger. No duplicate added.',
      'chat-hold-reject-reason'
    );
    dupLine.style.fontSize = '12.5px';
    dupLine.style.color = 'var(--text-muted)';
    dupLine.style.marginTop = '4px';
    msgCard.appendChild(dupLine);
  } else if (isHoldOrReject || !isPass) {
    const holdRejectMsg = hasNoInvoiceData
      ? 'This invoice has no data. Rejected invoices cannot be posted to the ledger.'
      : cleanReasonDisplayText(res.explanation || TERM_MEANINGS[displayTerm] || 'Held or rejected invoices are saved after review.');
    const reasonText = el('div', holdRejectMsg, 'chat-hold-reject-reason');
    reasonText.style.fontSize = '12.5px';
    reasonText.style.color = 'var(--text-muted)';
    reasonText.style.marginTop = '4px';
    msgCard.appendChild(reasonText);
  }

  const actionStatusEl = el('div', '', 'status-banner hidden');

  btnPost.addEventListener('click', async () => {
    if (btnPost.disabled || hasNoInvoiceData) return;
    actionStatusEl.className = 'status-banner info';
    actionStatusEl.textContent = 'Posting invoice to ledger...';
    try {
      const rawDate = inv.invoiceDate || inv.PostingDate || inv.postingDate;
      let cleanDate = String(rawDate || '').trim();
      if (/^\d{2}\/\d{2}\/\d{4}$/.test(cleanDate)) {
        const [d, m, y] = cleanDate.split('/');
        cleanDate = `${y}-${m}-${d}`;
      }
      if (!cleanDate || cleanDate === '—') {
        cleanDate = new Date().toISOString().slice(0, 10);
      }

      const payload = {
        invoiceNo: inv.invoiceNo || checkedFileName || 'INV-000',
        supplierName: inv.supplierName || 'Supplier',
        supplierGstin: inv.supplierGstin || '',
        invoiceDate: cleanDate,
        postingDate: new Date().toISOString().slice(0, 10),
        total: inv.total !== undefined && inv.total !== null ? Number(inv.total) : 0,
        fiscalYear: inv.fiscalYear || '2026-2027',
      };

      const out = await api('postToLedger', payload);
      if (out.alreadyInLedger) {
        actionStatusEl.className = 'status-banner info';
        actionStatusEl.textContent = 'This invoice is already saved in the ledger. No duplicate added.';
        btnPost.textContent = 'Saved in ledger';
        btnPost.disabled = true;
        loadTopSummary();
      } else if (out.posted || out.ok) {
        actionStatusEl.className = 'status-banner success';
        actionStatusEl.textContent = 'Saved to ledger.';
        btnPost.textContent = 'Saved ✓';
        btnPost.disabled = true;
        loadTopSummary();
      } else {
        actionStatusEl.className = 'status-banner error';
        actionStatusEl.textContent = out.explanation || out.message || 'Failed to post invoice to ledger.';
      }
    } catch (err) {
      actionStatusEl.className = 'status-banner error';
      actionStatusEl.textContent = err.message || 'Posting to ledger failed.';
    }
  });

  btnSave.addEventListener('click', async () => {
    actionStatusEl.className = 'status-banner success';
    actionStatusEl.textContent = 'Result saved to check history.';
    btnSave.textContent = 'Saved ✓';
    btnSave.disabled = true;
    loadTopSummary();
    if ($('page-history') && $('page-history').classList.contains('active')) {
      loadCheckHistory(state.historyPage || 1);
    }
    if ($('page-activity') && $('page-activity').classList.contains('active')) {
      loadActivityLog(state.activityPage || 1);
    }
  });

  msgCard.appendChild(actionStatusEl);

  return msgCard;
}

function parseMarkdownTableBlock(tableLines, contextTitle = '') {
  if (!Array.isArray(tableLines) || tableLines.length < 2) return null;
  const splitRow = (line) =>
    String(line || '')
      .trim()
      .replace(/^\|/, '')
      .replace(/\|$/, '')
      .split('|')
      .map(c => c.trim());

  const headers = splitRow(tableLines[0]);
  if (headers.length === 0) return null;

  // Check if row 1 is a separator line like | --- | --- |
  const isSep = (line) => /^\|?\s*:?-{2,}:?(?:\s*\|\s*:?-{2,}:?)+\s*\|?$/.test(String(line || '').trim());
  const startRowIdx = isSep(tableLines[1]) ? 2 : 1;
  const rows = [];
  for (let i = startRowIdx; i < tableLines.length; i++) {
    if (isSep(tableLines[i])) continue;
    const cells = splitRow(tableLines[i]);
    if (cells.length > 0 && cells.some(Boolean)) {
      rows.push(cells);
    }
  }

  const headerJoined = headers.join(' ').toLowerCase();
  const ctxLower = String(contextTitle || '').toLowerCase();

  // Determine whether this is the classic Ledger table or one of the other Tab tables
  let variant = 'ledger';
  let bannerLabel = '';
  let bannerMeta = '';

  if (/review\s*queue|open\s*alert/i.test(ctxLower) || /rule\s*\/\s*issue/i.test(headerJoined)) {
    variant = 'review';
    bannerLabel = '3. Review Queue · Open Alerts';
    bannerMeta = `${rows.length} alert${rows.length === 1 ? '' : 's'}`;
  } else if (/activity\s*log|audit/i.test(ctxLower) || /entry\s*#|timestamp/i.test(headerJoined)) {
    variant = 'activity';
    bannerLabel = '5. Activity Log · Audit Trail';
    bannerMeta = `${rows.length} entr${rows.length === 1 ? 'y' : 'ies'}`;
  } else if (/check\s*history|total\s*invoices:/i.test(ctxLower) || /\bverdict\b/i.test(headerJoined)) {
    variant = 'history';
    bannerLabel = '4. Check History · Verification Log';
    bannerMeta = `${rows.length} check${rows.length === 1 ? '' : 's'}`;
  } else if (/difference|తేడా|4\.\s*check\s*history/i.test(ctxLower) || /4\.\s*check\s*history/i.test(headerJoined)) {
    variant = 'compare';
    bannerLabel = 'Tab Comparison · System Guide';
    bannerMeta = 'Overview';
  }

  const wrapClass = variant === 'ledger'
    ? 'chat-table-wrap chat-variant-ledger'
    : `chat-table-wrap chat-variant-tab chat-variant-${variant}`;
  const wrap = el('div', null, wrapClass);

  if (variant !== 'ledger' && bannerLabel) {
    const banner = el('div', null, 'chat-tab-table-banner');
    const titleWrap = el('span', null, 'chat-tab-banner-title');
    titleWrap.append(
      el('span', '', 'chat-tab-banner-dot'),
      el('span', bannerLabel)
    );
    const metaEl = el('span', bannerMeta, 'chat-tab-banner-meta');
    banner.append(titleWrap, metaEl);
    wrap.appendChild(banner);
  }

  const table = el('table', null, 'chat-grid-table');
  const thead = document.createElement('thead');
  const trHead = document.createElement('tr');

  const numColIndices = new Set();
  const codeColIndices = new Set();
  const dateColIndices = new Set();
  const idxColIndices = new Set();
  const statusColIndices = new Set();
  const actionColIndices = new Set();

  headers.forEach((h, colIdx) => {
    const th = el('th', h);
    if (/total|amount|inr|value|cost/i.test(h)) {
      numColIndices.add(colIdx);
      th.className = 'chat-col-num';
    } else if (/^#$|^entry\s*#$/i.test(h.trim())) {
      idxColIndices.add(colIdx);
      th.className = 'chat-col-idx';
    } else if (/invoice\s*no|invoice\s*id|^id$/i.test(h)) {
      codeColIndices.add(colIdx);
      th.className = 'chat-col-code';
    } else if (/date|timestamp|time/i.test(h)) {
      dateColIndices.add(colIdx);
      th.className = 'chat-col-date';
    } else if (/^(status|verdict)$/i.test(h.trim())) {
      statusColIndices.add(colIdx);
    } else if (/^action$/i.test(h.trim())) {
      actionColIndices.add(colIdx);
    }
    trHead.appendChild(th);
  });
  thead.appendChild(trHead);
  table.appendChild(thead);

  const tbody = document.createElement('tbody');
  const colSums = {};
  numColIndices.forEach(idx => { colSums[idx] = 0; });
  let hasNumericValue = false;

  rows.forEach((cells) => {
    const tr = document.createElement('tr');
    headers.forEach((_, colIdx) => {
      const val = cells[colIdx] !== undefined ? cells[colIdx] : '—';
      const td = document.createElement('td');
      const upperVal = String(val).trim().toUpperCase();

      const displayVal = (dateColIndices.has(colIdx) && /^\d{4}-\d{2}-\d{2}[T\s]\d{2}:\d{2}/.test(String(val).trim()))
        ? formatIST(String(val).trim())
        : val;

      if (variant !== 'ledger' && statusColIndices.has(colIdx) && ['PASS', 'HOLD', 'REJECT'].includes(upperVal)) {
        td.appendChild(el('span', upperVal, `badge ${upperVal}`));
      } else if (variant !== 'ledger' && actionColIndices.has(colIdx) && val !== '—') {
        td.appendChild(el('span', formatActionPlainWord(val), 'chat-action-pill'));
      } else {
        td.textContent = displayVal;
      }

      if (numColIndices.has(colIdx)) {
        td.className = 'chat-col-num';
        const cleanedNum = Number(String(val).replace(/[^0-9.-]+/g, ''));
        if (!Number.isNaN(cleanedNum) && String(val).replace(/[^0-9]+/g, '').length > 0) {
          colSums[colIdx] = (colSums[colIdx] || 0) + cleanedNum;
          hasNumericValue = true;
        }
      } else if (idxColIndices.has(colIdx)) {
        td.className = 'chat-col-idx';
      } else if (codeColIndices.has(colIdx)) {
        td.className = 'chat-col-code';
      } else if (dateColIndices.has(colIdx)) {
        td.className = 'chat-col-date';
      }
      tr.appendChild(td);
    });
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);

  // Requirement 13: Include a Grand Total row whenever applicable
  if (rows.length > 0 && variant !== 'compare') {
    const tfoot = document.createElement('tfoot');
    const trFoot = document.createElement('tr');
    trFoot.className = 'grand-total-row';

    if (numColIndices.size > 0 && hasNumericValue) {
      const firstNumIdx = Math.min(...Array.from(numColIndices));
      if (firstNumIdx > 0) {
        const tdTotalLabel = el('td', `Grand Total (${rows.length} ${rows.length === 1 ? 'row' : 'rows'})`);
        tdTotalLabel.colSpan = firstNumIdx;
        trFoot.appendChild(tdTotalLabel);
      }
      for (let c = firstNumIdx; c < headers.length; c++) {
        if (numColIndices.has(c)) {
          const tdSum = el('td', formatMoney(colSums[c] || 0), 'chat-col-num');
          trFoot.appendChild(tdSum);
        } else {
          trFoot.appendChild(el('td', c === 0 ? 'Grand Total' : ''));
        }
      }
    } else if (headers.length >= 2) {
      const tdLabel = el('td', 'Grand Total');
      tdLabel.colSpan = headers.length - 1;
      const tdCount = el('td', `${rows.length} ${rows.length === 1 ? 'record' : 'records'}`, 'chat-col-num');
      trFoot.append(tdLabel, tdCount);
    }
    tfoot.appendChild(trFoot);
    table.appendChild(tfoot);
  }

  const scrollBox = el('div', null, 'chat-table-scroll');
  scrollBox.appendChild(table);
  wrap.appendChild(scrollBox);
  return wrap;
}

function renderFormattedAssistantReply(container, rawText) {
  if (!container) return;
  container.textContent = '';
  const text = String(rawText || '');
  const lines = text.split('\n');

  let i = 0;
  let hasAppendedBlock = false;
  let lastNonEmptyLine = '';
  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();

    // Detect start of a Markdown pipe table: | Col1 | Col2 | ...
    if (trimmed.startsWith('|') && trimmed.endsWith('|') && trimmed.split('|').length >= 3) {
      const tableLines = [];
      while (i < lines.length) {
        const tLine = lines[i].trim();
        if (tLine.startsWith('|') && tLine.includes('|')) {
          tableLines.push(lines[i]);
          i++;
        } else {
          break;
        }
      }
      const tableNode = parseMarkdownTableBlock(tableLines, lastNonEmptyLine);
      if (tableNode) {
        container.appendChild(tableNode);
        hasAppendedBlock = true;
        continue;
      }
    }
    if (trimmed) {
      lastNonEmptyLine = trimmed;
    }

    if (hasAppendedBlock && trimmed) {
      container.appendChild(document.createTextNode('\n'));
    }

    if (!trimmed) {
      if (hasAppendedBlock) {
        container.appendChild(document.createTextNode('\n'));
      }
      i++;
      continue;
    }

    // Match "Label: Value" or "• Label: Value" or "- Label: Value"
    const kvMatch = line.match(/^(\s*(?:[•\-*]\s+|\d+\.\s+)?[^:\n]{2,48}:)(\s+.*)$/);
    if (kvMatch) {
      const strongEl = el('strong', kvMatch[1], 'ai-main-label');
      const valEl = el('span', kvMatch[2], 'ai-normal-value');
      container.append(strongEl, valEl);
      hasAppendedBlock = true;
      i++;
      continue;
    }

    // Match standalone section heading ending with ":"
    if (/^(\s*[^:\n]{3,65}:)\s*$/.test(line)) {
      const strongEl = el('strong', line, 'ai-main-label');
      container.appendChild(strongEl);
      hasAppendedBlock = true;
      i++;
      continue;
    }

    const spanEl = el('span', line, 'ai-normal-value');
    container.appendChild(spanEl);
    hasAppendedBlock = true;
    i++;
  }
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
  if (inner.classList.contains('empty-chat-state')) {
    inner.classList.remove('empty-chat-state');
  }
  const greetingMsg = inner.querySelector('.chat-greeting-message');
  if (greetingMsg) {
    greetingMsg.remove();
  }
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

    const fileExt = String(fileToSend.ext || fileToSend.name || '').toLowerCase().split('.').pop();
    if (fileExt === 'csv' || fileExt === 'json') {
      try {
        let contentText = fileToSend.rawText || '';
        if (!contentText && fileToSend.base64) {
          contentText = atob(fileToSend.base64);
        }
        const imp = await api('importS4Extract', { fileName: fileToSend.name, content: contentText });
        const colLine = imp.columnsFound || '';
        const validInvoices = Array.isArray(imp.invoices) ? imp.invoices : [];
        const rowErrors = Array.isArray(imp.rowErrors) ? imp.rowErrors : [];

        const matchedCols = Array.isArray(imp.matchedColumns) && imp.matchedColumns.length ? imp.matchedColumns.join(', ') : (imp.matchedColumns || 'None');
        const missingCols = Array.isArray(imp.missingColumns) && imp.missingColumns.length ? imp.missingColumns.join(', ') : 'None';
        const colsFoundText = `Columns found: ${matchedCols}. Missing fields: ${missingCols}.`;

        if (validInvoices.length === 0) {
          thinkingBubble.remove();
          const msgBubble = el('div', null, 'chat-bubble assistant');
          msgBubble.appendChild(el('div', `${fileToSend.name}: 0 invoices checked (${rowErrors.length} row(s) rejected).`));
          msgBubble.appendChild(el('div', colsFoundText, 'hint'));
          if (rowErrors.length > 0) {
            const errTitle = el('strong', 'Rows with errors:', 'ai-main-label');
            msgBubble.appendChild(errTitle);
            rowErrors.slice(0, 20).forEach((er, idx) => {
              msgBubble.appendChild(el('div', `• Row ${er.row || idx + 1}: ${er.reason || er.invoiceNo || 'Failed to read'}`));
            });
          }
          appendMessageToChat(msgBubble);
          loadTopSummary();
          return;
        }

        state.s4List = validInvoices;
        thinkingBubble.textContent = `0 of ${validInvoices.length} checked...`;
        const job = await api('checkBatch', {
          fileName: fileToSend.name,
          invoices: JSON.stringify(validInvoices),
          errors: JSON.stringify(rowErrors),
        });
        const jobId = job && (job.jobId || job.id);
        state.currentJobId = jobId;

        let finalJob = job;
        if (jobId) {
          for (let attempt = 0; attempt < 120; attempt++) {
            const st = await fetchJobStatus(jobId);
            if (st) {
              finalJob = st;
              thinkingBubble.textContent = `${st.processed || 0} of ${st.total || validInvoices.length} checked...`;
              if (st.status === 'DONE' || st.status === 'FAILED' || st.status === 'CANCELLED') {
                break;
              }
            }
            await new Promise(r => setTimeout(r, 350));
          }
        }

        thinkingBubble.remove();
        await loadS4Results(1, true);
        await loadTopSummary();

        const summaryBubble = el('div', null, 'chat-bubble assistant chat-result-message');
        const totalChecked = (finalJob && finalJob.processed) || validInvoices.length;
        const passCnt = (finalJob && finalJob.passCount) || 0;
        const holdCnt = (finalJob && finalJob.holdCount) || 0;
        const rejCnt = (finalJob && finalJob.rejectCount) || 0;

        const summaryHeader = el(
          'div',
          `${fileToSend.name}: ${totalChecked} invoices checked. ${passCnt} PASS, ${holdCnt} HOLD, ${rejCnt} REJECT.`,
          'result-field-line'
        );
        summaryHeader.style.fontWeight = '600';
        summaryBubble.appendChild(summaryHeader);

        const colEl = el('div', colsFoundText, 'result-field-line');
        colEl.style.marginBottom = '8px';
        colEl.style.fontSize = '13px';
        colEl.style.color = 'var(--text-muted)';
        summaryBubble.appendChild(colEl);

        const s4Rows = state.s4Results || [];
        const flagged = s4Rows.filter(r => r.status === 'HOLD' || r.status === 'REJECT');
        if (flagged.length > 0) {
          const flagWrap = el('div', null, 'chat-active-rules-list');
          flagged.slice(0, 20).forEach(r => {
            const rowLine = el('div', null, 'chat-rule-line');
            rowLine.append(
              el('span', r.status, `badge ${r.status}`),
              el('span', `${r.invoiceNo || '-'} (${r.supplierName || '-'}): ${r.reason || '-'}`, 'rule-reason')
            );
            flagWrap.appendChild(rowLine);
          });
          if (flagged.length > 20) {
            flagWrap.appendChild(el('div', `and ${flagged.length - 20} more flagged rows`, 'hint'));
          }
          summaryBubble.appendChild(flagWrap);
        }

        const allErrors = (finalJob && Array.isArray(finalJob.errors) && finalJob.errors.length)
          ? finalJob.errors
          : rowErrors;
        if (allErrors.length > 0) {
          const errWrap = el('div', null, 'result-fields-lines');
          errWrap.style.marginTop = '8px';
          errWrap.appendChild(el('strong', 'Rows with errors:', 'result-field-label'));
          allErrors.slice(0, 20).forEach((er, idx) => {
            errWrap.appendChild(el('div', `• Row ${er.row || idx + 1}: ${er.reason || `${er.invoiceNo || 'Row'}: Failed`}`, 'result-field-line'));
          });
          summaryBubble.appendChild(errWrap);
        }

        const actionsRow = el('div', null, 'chat-result-actions');
        const btnOpenAll = el('button', 'Open all results', 'primary');
        btnOpenAll.type = 'button';
        btnOpenAll.addEventListener('click', () => {
          switchPage('s4');
          loadS4Results(1);
        });
        actionsRow.appendChild(btnOpenAll);
        summaryBubble.appendChild(actionsRow);

        appendMessageToChat(summaryBubble);

        if (trimmedPrompt) {
          await askQuestionInAiThread(trimmedPrompt);
        }
      } catch (err) {
        thinkingBubble.remove();
        appendMessageToChat(el('div', err.message, 'chat-bubble assistant'));
      }
      return;
    }

    try {
      const out = await api('chatCheckInvoice', {
        fileName: fileToSend.name,
        fileSize: fileToSend.size,
        fileBase64: fileToSend.base64,
      });

      thinkingBubble.remove();
      state.fields = out.fields || {};

      if (out.ok === false) {
        state.currentResult = out;
        const failCard = renderAiChatResultMessage(out, fileToSend.name);
        appendMessageToChat(failCard);
        loadTopSummary();
        return;
      }

      state.currentResult = out;
      const resultMsg = renderAiChatResultMessage(out, fileToSend.name);
      appendMessageToChat(resultMsg);
      loadTopSummary();

      if (trimmedPrompt) {
        await askQuestionInAiThread(trimmedPrompt, out.checkId || '');
      }
    } catch (err) {
      thinkingBubble.remove();
      appendMessageToChat(el('div', err.message, 'chat-bubble assistant'));
      loadTopSummary();
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
  const displayTerm = toDisplayStatusTerm(res, verdict, false);
  const header = el('div', `${headingPrefix} — ${displayTerm} (${res.status})`, 'verdict-badge');
  container.appendChild(header);

  const listWrap = el('div', null, 'chat-active-rules-list');
  listWrap.style.marginTop = '10px';
  for (const r of activeRows) {
    const row = el('div', null, 'chat-rule-line');
    row.append(
      el('span', r.tier, `badge ${r.tier}`),
      el('span', cleanReasonDisplayText(r.text || ''), 'rule-reason')
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

function setS4SourceChip(sourceType = 'uploaded') {
  const badge = $('sapSourceBadge');
  if (!badge) return;
  if (sourceType === 'sap') {
    badge.textContent = 'Source: SAP sandbox (demo data)';
  } else {
    badge.textContent = 'Source: Uploaded file';
  }
}

function closeAllDropdowns() {
  if ($('s4MoreDropdown')) $('s4MoreDropdown').classList.add('hidden');
  if ($('btnS4MoreMenu')) $('btnS4MoreMenu').setAttribute('aria-expanded', 'false');
  if ($('s4DownloadDropdown')) $('s4DownloadDropdown').classList.add('hidden');
  if ($('btnS4DownloadMenu')) $('btnS4DownloadMenu').setAttribute('aria-expanded', 'false');
}

document.addEventListener('click', (e) => {
  const moreWrap = $('s4MoreMenuWrap');
  const dlWrap = $('s4DownloadMenuWrap');
  if (moreWrap && !moreWrap.contains(e.target)) {
    if ($('s4MoreDropdown')) $('s4MoreDropdown').classList.add('hidden');
    if ($('btnS4MoreMenu')) $('btnS4MoreMenu').setAttribute('aria-expanded', 'false');
  }
  if (dlWrap && !dlWrap.contains(e.target)) {
    if ($('s4DownloadDropdown')) $('s4DownloadDropdown').classList.add('hidden');
    if ($('btnS4DownloadMenu')) $('btnS4DownloadMenu').setAttribute('aria-expanded', 'false');
  }
});

if ($('btnS4MoreMenu')) {
  $('btnS4MoreMenu').addEventListener('click', (e) => {
    e.stopPropagation();
    const menu = $('s4MoreDropdown');
    if (!menu) return;
    const isHidden = menu.classList.toggle('hidden');
    $('btnS4MoreMenu').setAttribute('aria-expanded', String(!isHidden));
    if ($('s4DownloadDropdown')) $('s4DownloadDropdown').classList.add('hidden');
  });
}

if ($('btnS4DownloadMenu')) {
  $('btnS4DownloadMenu').addEventListener('click', (e) => {
    e.stopPropagation();
    const menu = $('s4DownloadDropdown');
    if (!menu) return;
    const isHidden = menu.classList.toggle('hidden');
    $('btnS4DownloadMenu').setAttribute('aria-expanded', String(!isHidden));
    if ($('s4MoreDropdown')) $('s4MoreDropdown').classList.add('hidden');
  });
}

if ($('s4FileInput')) {
  $('s4FileInput').addEventListener('change', () => {
    const files = $('s4FileInput').files ? Array.from($('s4FileInput').files) : [];
    const label = $('s4SelectedFileLabel');
    if (!label) return;
    if (!files.length) {
      label.textContent = 'No file selected';
    } else if (files.length === 1) {
      label.textContent = files[0].name;
    } else {
      label.textContent = `${files.length} files selected`;
    }
  });
}

function openS4DetailDrawer(row, sourceTab = 's4') {
  const drawer = $('s4DetailDrawer');
  const backdrop = $('s4DrawerBackdrop');
  const titleEl = $('s4DrawerTitle');
  const subEl = $('s4DrawerSubtitle');
  const bodyEl = $('s4DrawerBody');
  if (!drawer || !bodyEl) return;

  let parsedPayload = {};
  if (row && row.resultJson) {
    try {
      parsedPayload = typeof row.resultJson === 'string'
        ? JSON.parse(row.resultJson || '{}')
        : (row.resultJson || {});
    } catch {
      parsedPayload = {};
    }
  }

  const mergedFields = { ...(parsedPayload.fields || {}), ...(row.fields || {}) };
  const invNo = formatCellValue(row.invoiceNo || row.invoiceId || row.id || mergedFields.invoiceNo);
  const supp = formatCellValue(row.supplierName || mergedFields.supplierName);
  const gstin = formatCellValue(row.supplierGstin || mergedFields.supplierGstin);
  const dateVal = formatCellValue(
    row.invoiceDate ||
    mergedFields.invoiceDate ||
    mergedFields.PostingDate ||
    mergedFields.postingDate ||
    (row.createdAt ? formatIST(row.createdAt, false) : '')
  );
  const amtNum = row.amountInr !== undefined && row.amountInr !== null ? row.amountInr : row.total;
  const totalVal = formatMoney(amtNum);
  const statusVal = row.status || (row.blocked ? 'HOLD' : 'PASS');

  if (titleEl) titleEl.textContent = `Invoice ${invNo}`;
  if (subEl) subEl.textContent = supp;
  bodyEl.textContent = '';

  // Section 1: Summary & Status
  const summarySec = el('div', null, 'drawer-section');
  summarySec.appendChild(el('div', 'Invoice overview', 'drawer-section-title'));
  const kvGrid = el('div', null, 'drawer-kv-grid');
  const addKv = (label, valNodeOrStr) => {
    kvGrid.appendChild(el('div', label, 'drawer-kv-label'));
    const valWrap = el('div', null, 'drawer-kv-val');
    if (typeof valNodeOrStr === 'string') {
      valWrap.textContent = valNodeOrStr;
    } else if (valNodeOrStr) {
      valWrap.appendChild(valNodeOrStr);
    }
    kvGrid.appendChild(valWrap);
  };

  addKv('Status', el('span', statusVal, `badge ${statusVal}`));
  addKv('Invoice No', invNo);
  addKv('Supplier', supp);
  addKv('GSTIN', gstin);
  addKv('Invoice date', dateVal);
  if (row.postingDate || row.postedAt) {
    addKv('Posting date', formatCellValue(row.postedAt ? formatIST(row.postedAt) : row.postingDate));
  }
  if (row.createdAt && sourceTab !== 'ledger') {
    addKv('Checked at', formatIST(row.createdAt));
  }
  addKv('Total (INR)', totalVal);

  if (sourceTab === 'ledger') {
    addKv('Fiscal year', formatCellValue(row.fiscalYear));
    addKv('Source', formatCellValue(row.source || 'Import'));
    if (row.description) {
      addKv('Description', formatCellValue(row.description));
    }
  } else {
    const dbMatch = row.databaseMatch || parsedPayload.databaseMatch;
    const sapMatch = row.sapMatch || parsedPayload.sapMatch;
    if (dbMatch) addKv('In ledger', formatLedgerMatchPlain(dbMatch));
    if (sapMatch) addKv('In SAP', formatSapMatchPlain(sapMatch));
    if (row.fileName || row.source) {
      addKv('File / Source', formatCellValue(row.fileName || row.source));
    }
    if (row.createdBy) {
      addKv('Reviewed by', formatReviewerName(row.createdBy));
    }
  }

  if (mergedFields.CompanyCode) addKv('Company code', formatCellValue(mergedFields.CompanyCode));
  if (mergedFields.FiscalYear && sourceTab !== 'ledger') addKv('Fiscal year', formatCellValue(mergedFields.FiscalYear));
  if (mergedFields.SupplierInvoiceIDByInvcgParty) addKv('Reference', formatCellValue(mergedFields.SupplierInvoiceIDByInvcgParty));
  if (mergedFields.description && !row.description) addKv('Description', formatCellValue(mergedFields.description));

  summarySec.appendChild(kvGrid);
  bodyEl.appendChild(summarySec);

  // Section 2: Active Rule Evaluations
  if (sourceTab !== 'ledger') {
    const rulesSec = el('div', null, 'drawer-section');
    rulesSec.appendChild(el('div', 'Rule evaluation', 'drawer-section-title'));
    const rawActive = Array.isArray(row.activeResults)
      ? row.activeResults
      : (Array.isArray(parsedPayload.activeResults)
          ? parsedPayload.activeResults
          : (Array.isArray(parsedPayload.results)
              ? parsedPayload.results.filter(x => ['AP-02', 'AP-03', 'AP-09', 'AP-11'].includes(x.id))
              : []));
    if (rawActive.length > 0) {
      const rulesList = el('div', null, 'chat-active-rules-list');
      rawActive.forEach(r => {
        const line = el('div', null, 'chat-rule-line');
        const cleanText = String(r.text || '').replace(/^AP-\d+\s*·?\s*/i, '').trim();
        line.append(
          el('span', r.tier || 'PASS', `badge ${r.tier || 'PASS'}`),
          el('span', cleanText || formatCellValue(r.title), 'rule-reason')
        );
        rulesList.appendChild(line);
      });
      rulesSec.appendChild(rulesList);
    } else {
      rulesSec.appendChild(el('div', formatCellValue(row.reason || parsedPayload.explanation || 'All active rules passed'), 'hint'));
    }
    bodyEl.appendChild(rulesSec);
  }

  // Section 3: Row Notes
  const rawNotes = Array.isArray(row.rowNotes)
    ? row.rowNotes
    : (Array.isArray(parsedPayload.rowNotes) ? parsedPayload.rowNotes : []);
  const notes = rawNotes.filter(Boolean);
  if (notes.length > 0) {
    const notesSec = el('div', null, 'drawer-section');
    notesSec.appendChild(el('div', 'Row notes', 'drawer-section-title'));
    notes.forEach(n => {
      const p = el('div', `• ${n}`, 'hint');
      p.style.marginBottom = '4px';
      notesSec.appendChild(p);
    });
    bodyEl.appendChild(notesSec);
  }

  drawer.classList.remove('hidden');
  if (backdrop) backdrop.classList.remove('hidden');
}

function closeS4DetailDrawer() {
  if ($('s4DetailDrawer')) $('s4DetailDrawer').classList.add('hidden');
  if ($('s4DrawerBackdrop')) $('s4DrawerBackdrop').classList.add('hidden');
}

if ($('btnCloseS4Drawer')) {
  $('btnCloseS4Drawer').addEventListener('click', closeS4DetailDrawer);
}
if ($('s4DrawerBackdrop')) {
  $('s4DrawerBackdrop').addEventListener('click', closeS4DetailDrawer);
}

async function loadS4Results(page = 1, isPolling = false) {
  state.s4Page = page;
  const status = $('s4FilterStatus') ? $('s4FilterStatus').value : 'ALL';
  const search = $('s4FilterSearch') ? $('s4FilterSearch').value.trim() : '';

  if (!isPolling && $('s4TableBody') && (!state.s4Results || state.s4Results.length === 0)) {
    renderTableSkeleton($('s4TableBody'), 6, 4);
  }

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
    const data = await parseJsonResponse(res);
    if (!data) return;
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

  // Server check results: 6 columns (Invoice No, Supplier, Date, Total (INR), Status, Reason)
  if (state.s4Results && state.s4Results.length > 0) {
    let sumTotal = 0;
    state.s4Results.forEach(r => {
      const tr = document.createElement('tr');
      tr.className = 'clickable-row';
      tr.tabIndex = 0;

      const tdStatus = document.createElement('td');
      tdStatus.appendChild(el('span', r.status || 'PASS', `badge ${r.status || 'PASS'}`));

      const reasonText = r.reason || (r.status === 'PASS' ? 'All active rules passed' : '—');
      const tdReason = createClampedReasonCell(reasonText);

      const numAmt = Number(r.total);
      if (!Number.isNaN(numAmt)) sumTotal += numAmt;

      tr.append(
        el('td', formatCellValue(r.invoiceNo || r.invoiceId), 'mono-cell'),
        el('td', formatCellValue(r.supplierName)),
        el('td', formatCellValue(r.invoiceDate), 'mono-cell'),
        el('td', formatMoney(r.total), 'num-col'),
        tdStatus,
        tdReason
      );

      tr.addEventListener('click', () => openS4DetailDrawer(r));
      tr.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          openS4DetailDrawer(r);
        }
      });

      tbody.appendChild(tr);
    });
    renderTableGrandTotal(tbody, {
      totalCols: 6,
      amountColIndex: 3,
      totalAmount: sumTotal,
      label: `Grand Total (${state.s4Results.length} ${state.s4Results.length === 1 ? 'invoice' : 'invoices'})`,
      trailingText: 'INR',
    });
    return;
  }

  // Pre-check preview if s4List is populated but check hasn't run yet
  if (state.s4List && state.s4List.length > 0 && !state.currentJobId) {
    const previewRows = state.s4List.slice(0, 50);
    let sumPreview = 0;
    previewRows.forEach(inv => {
      const tr = document.createElement('tr');
      tr.className = 'clickable-row';
      const tdStatus = document.createElement('td');
      tdStatus.appendChild(el('span', 'HOLD', 'badge SKIPPED'));
      tdStatus.firstChild.textContent = 'Ready';

      const rawAmt = inv.total !== undefined ? inv.total : inv.InvoiceGrossAmount;
      const numAmt = Number(rawAmt);
      if (!Number.isNaN(numAmt)) sumPreview += numAmt;

      const dateVal = formatCellValue(inv.invoiceDate || inv.PostingDate || inv.postingDate);
      tr.append(
        el('td', formatCellValue(inv.invoiceNo || inv.SupplierInvoice || inv.id), 'mono-cell'),
        el('td', formatCellValue(inv.supplierName || inv.InvoicingParty)),
        el('td', dateVal, 'mono-cell'),
        el('td', formatMoney(rawAmt), 'num-col'),
        tdStatus,
        createClampedReasonCell('Click "Check all" to evaluate')
      );
      tr.addEventListener('click', () => openS4DetailDrawer(inv));
      tbody.appendChild(tr);
    });
    renderTableGrandTotal(tbody, {
      totalCols: 6,
      amountColIndex: 3,
      totalAmount: sumPreview,
      label: `Grand Total (${previewRows.length} ${previewRows.length === 1 ? 'invoice' : 'invoices'})`,
      trailingText: 'INR',
    });
    return;
  }

  if (state.currentJobId) {
    renderEmptyTableState(
      tbody,
      6,
      'No invoices match the selected filter.',
      'Reset filter',
      () => {
        setS4StatusFilter('ALL');
        if ($('s4FilterSearch')) $('s4FilterSearch').value = '';
        loadS4Results(1);
      }
    );
    return;
  }

  renderEmptyTableState(
    tbody,
    6,
    'No batch checked yet. Upload a Fiori export CSV to start.',
    'Choose files',
    () => {
      if ($('s4FileInput')) $('s4FileInput').click();
    }
  );
}

function renderSapTestTable(invoices = [], autoShow = true) {
  const wrap = $('sapTestConnectionWrap');
  const tbody = $('sapTestTableBody');
  const toggleBtn = $('btnToggleSapSample');
  if (!wrap || !tbody) return;
  tbody.textContent = '';

  if (!Array.isArray(invoices) || invoices.length === 0) {
    clearTableGrandTotal(tbody);
    wrap.classList.add('hidden');
    return;
  }

  state.sapSampleFetched = true;
  if (toggleBtn) {
    toggleBtn.textContent = `View SAP sandbox sample (${invoices.length})`;
  }
  if (autoShow) {
    wrap.classList.remove('hidden');
  }

  let sumGross = 0;
  for (const row of invoices) {
    const tr = document.createElement('tr');
    const numGross = Number(row.InvoiceGrossAmount);
    if (!Number.isNaN(numGross) && row.InvoiceGrossAmount !== '' && row.InvoiceGrossAmount !== undefined) {
      sumGross += numGross;
    }
    tr.append(
      el('td', formatCellValue(row.SupplierInvoice), 'mono-cell'),
      el('td', formatCellValue(row.FiscalYear), 'mono-cell'),
      el('td', formatCellValue(row.CompanyCode), 'mono-cell'),
      el('td', formatCellValue(row.InvoicingParty), 'mono-cell'),
      el('td', row.InvoiceGrossAmount !== '' && row.InvoiceGrossAmount !== undefined ? formatMoney(row.InvoiceGrossAmount) : '—', 'num-col'),
      el('td', formatCellValue(row.DocumentCurrency), 'mono-cell'),
      el('td', formatCellValue(row.InvoiceDate), 'mono-cell'),
      el('td', formatCellValue(row.PostingDate), 'mono-cell'),
      el('td', formatCellValue(row.SupplierInvoiceIDByInvcgParty), 'mono-cell'),
      el('td', row.note || (row.missingFields && row.missingFields.length ? `Missing: ${row.missingFields.join(', ')}` : 'All fields present'), 'hint')
    );
    tbody.append(tr);
  }
  renderTableGrandTotal(tbody, {
    totalCols: 10,
    amountColIndex: 4,
    totalAmount: sumGross,
    label: `Grand Total (${invoices.length} sample ${invoices.length === 1 ? 'invoice' : 'invoices'})`,
    trailingText: 'INR',
  });
}

if ($('btnToggleSapSample')) {
  $('btnToggleSapSample').addEventListener('click', () => {
    const wrap = $('sapTestConnectionWrap');
    if (!wrap) return;
    if (state.sapSampleFetched) {
      wrap.classList.toggle('hidden');
    } else if ($('btnTestSapConnection')) {
      $('btnTestSapConnection').click();
    }
  });
}

if ($('btnCloseSapPreview')) {
  $('btnCloseSapPreview').addEventListener('click', () => {
    if ($('sapTestConnectionWrap')) $('sapTestConnectionWrap').classList.add('hidden');
  });
}

if ($('btnTestSapConnection')) {
  $('btnTestSapConnection').addEventListener('click', async () => {
    closeAllDropdowns();
    setBanner('s4Banner', 'Testing connection to SAP sandbox (demo data)...', 'info');
    try {
      const res = await fetch('/fraud/testSapConnection', {
        method: 'GET',
        headers: getHeaders(),
      });
      const data = (await parseJsonResponse(res)) || {};
      if (!data.ok) {
        if ($('sapTestConnectionWrap')) $('sapTestConnectionWrap').classList.add('hidden');
        const statusMsg = data.status || 'SAP unavailable';
        const reasonText = data.reason ? ` (${data.reason})` : '';
        setBanner('s4Banner', `${statusMsg} — ${data.sourceLabel || 'SAP sandbox (demo data)'}${reasonText}`, 'warning');
        showToast(statusMsg, 'info');
        return;
      }
      renderSapTestTable(data.invoices || [], true);
      setBanner(
        's4Banner',
        `Connected to ${data.sourceLabel || 'SAP sandbox (demo data)'}: fetched ${(data.invoices || []).length} sample invoice(s).`,
        'success'
      );
    } catch (_err) {
      if ($('sapTestConnectionWrap')) $('sapTestConnectionWrap').classList.add('hidden');
      setBanner('s4Banner', 'SAP unavailable — SAP sandbox (demo data)', 'warning');
    }
  });
}

if ($('btnFetchSapNow')) {
  $('btnFetchSapNow').addEventListener('click', async () => {
    closeAllDropdowns();
    setBanner('s4Banner', 'Fetching invoices from SAP sandbox (demo data)...', 'info');
    try {
      const res = await fetch('/fraud/fetchFromSapNow', {
        method: 'POST',
        headers: getHeaders(),
        body: JSON.stringify({ top: 20, runCheck: true }),
      });
      const data = (await parseJsonResponse(res)) || {};
      if (!data.ok) {
        const statusMsg = data.status || 'SAP unavailable';
        const reasonText = data.reason ? ` (${data.reason})` : '';
        setBanner('s4Banner', `${statusMsg} — ${data.sourceLabel || 'SAP sandbox (demo data)'}${reasonText}`, 'warning');
        showToast(statusMsg, 'info');
        return;
      }
      setS4SourceChip('sap');
      state.s4List = data.checkInvoices || [];
      state.s4Results = [];
      if ($('resultCardS4')) $('resultCardS4').classList.add('hidden');
      renderS4Table();
      loadTopSummary();

      if (data.jobId || data.id) {
        state.currentJobId = data.jobId || data.id;
        setBanner('s4Banner', `Fetched ${state.s4List.length} invoice(s) from ${data.sourceLabel || 'SAP sandbox (demo data)'}. Running checks...`, 'info');
        pollBatchJob(data.jobId || data.id, state.s4List.length);
      } else {
        setBanner('s4Banner', `Fetched ${state.s4List.length} invoice(s) from ${data.sourceLabel || 'SAP sandbox (demo data)'}.`, 'success');
      }
    } catch (_err) {
      setBanner('s4Banner', 'SAP unavailable — SAP sandbox (demo data)', 'warning');
    }
  });
}

if ($('btnUseSampleS4')) {
  $('btnUseSampleS4').addEventListener('click', async () => {
    closeAllDropdowns();
    setBanner('s4Banner', 'Loading sample S/4HANA extract...', 'info');
    try {
      setS4SourceChip('uploaded');
      state.s4List = await api('fetchS4Invoices', null, 'GET');
      state.s4Results = [];
      state.currentJobId = null;
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
    closeAllDropdowns();
    const input = $('s4FileInput');
    const files = input && input.files ? Array.from(input.files) : [];
    if (!files.length) {
      setBanner('s4Banner', 'Choose one or more extract or invoice files first.', 'error');
      return;
    }

    // Size limit check per file (10 MB)
    for (const f of files) {
      if (f.size > 10 * 1024 * 1024) {
        const msg = `File "${f.name}" is too large. Maximum size is 10 MB.`;
        setBanner('s4Banner', msg, 'error');
        showToast(msg, 'error');
        return;
      }
    }

    setS4SourceChip('uploaded');
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
        const job = (await parseJsonResponse(uploadRes)) || {};
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
      const allRowErrors = [];
      const columnsFoundLines = [];
      for (const f of files) {
        const text = await f.text();
        const out = await api('importS4Extract', { fileName: f.name, content: text });
        if (out && Array.isArray(out.invoices)) {
          mergedInvoices.push(...out.invoices);
        }
        if (out && Array.isArray(out.rowErrors) && out.rowErrors.length) {
          allRowErrors.push(...out.rowErrors);
        }
        if (out && out.columnsFound) {
          columnsFoundLines.push(files.length > 1 ? `${f.name} — ${out.columnsFound}` : out.columnsFound);
        }
      }

      if (columnsFoundLines.length > 0) {
        setBanner('s4ColumnsFoundBar', columnsFoundLines.join(' | '), 'info');
      } else {
        setBanner('s4ColumnsFoundBar', '');
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

      if (mergedInvoices.length === 0 && allRowErrors.length > 0) {
        updateS4ProgressUI({
          status: 'DONE',
          total: allRowErrors.length,
          processed: 0,
          errors: allRowErrors,
        }, allRowErrors.length);
        if ($('s4ErrorsModal')) $('s4ErrorsModal').classList.remove('hidden');
        setBanner('s4Banner', `0 valid rows imported. ${allRowErrors.length} row(s) rejected for missing required fields.`, 'warning');
        loadTopSummary();
        return;
      }

      setBanner('s4Banner', 'Processing started', 'info');
      const job = await api('checkBatch', {
        invoices: JSON.stringify(state.s4List),
        errors: JSON.stringify(allRowErrors),
      });
      loadTopSummary();
      if (job && (job.jobId || job.id)) {
        state.currentJobId = job.jobId || job.id;
        pollBatchJob(job.jobId || job.id, state.s4List.length);
      }
    } catch (err) {
      setBanner('s4Banner', err.message, 'error');
      showToast(err.message, 'error');
      loadTopSummary();
    }
  });
}

if ($('btnImportToLedger')) {
  $('btnImportToLedger').addEventListener('click', async () => {
    closeAllDropdowns();
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
      loadTopSummary();
      if ($('page-ledger') && $('page-ledger').classList.contains('active')) {
        loadLedgerView(1);
      }
    } catch (err) {
      setBanner('s4Banner', err.message, 'error');
    }
  });
}

async function executeDatabaseSearch(page = 1) {
  const targetPage = typeof page === 'number' && page > 0 ? page : 1;
  const input = $('inputSearchDb');
  const q = input ? input.value.trim() : '';
  const wrap = $('searchDbWrap');
  const tbody = $('searchDbTableBody');
  const pagBar = $('searchDbPagination');
  setBanner('searchDbBanner', 'Searching ledger...', 'info');
  if (wrap) wrap.classList.remove('hidden');
  if (tbody) renderTableSkeleton(tbody, 8, 3);

  try {
    const params = new URLSearchParams({
      query: q,
      page: String(targetPage),
      limit: '50',
    });
    const res = await fetch(`/fraud/searchDatabase?${params.toString()}`, {
      method: 'GET',
      headers: getHeaders(),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error((data && data.error && data.error.message) || `Request failed (${res.status})`);
    }

    const records = Array.isArray(data.rows) ? data.rows : (Array.isArray(data.value) ? data.value : (Array.isArray(data) ? data : []));
    const total = data.total !== undefined ? Number(data.total) : records.length;
    const totalPages = data.totalPages !== undefined ? Number(data.totalPages) : Math.ceil(total / 50);
    const sourceLabel = data.source || 'Source: Ledger (HANA)';

    if ($('searchDbSourceLabel')) {
      $('searchDbSourceLabel').textContent = sourceLabel;
    }

    if (!tbody || !wrap) return;
    tbody.textContent = '';
    wrap.classList.remove('hidden');
    if (pagBar) pagBar.classList.remove('hidden');

    if (!records.length) {
      renderEmptyTableState(tbody, 8, 'Not found in ledger.');
      setBanner('searchDbBanner', `Not found in database · ${sourceLabel}`, 'info');
      renderPagination('searchDb', {
        page: 1,
        totalPages: 0,
        total: 0,
        limit: 50,
        onPageChange: (p) => executeDatabaseSearch(p),
      });
      return;
    }

    let sumSearchTotal = 0;
    for (const r of records) {
      const tr = document.createElement('tr');
      const isBlocked = Boolean(r.blocked);
      const statusBadge = el('span', isBlocked ? 'HOLD' : 'PASS', `badge ${isBlocked ? 'HOLD' : 'PASS'}`);
      const tdStatus = document.createElement('td');
      tdStatus.appendChild(statusBadge);

      const numAmt = Number(r.total);
      if (!Number.isNaN(numAmt)) sumSearchTotal += numAmt;

      tr.append(
        el('td', formatCellValue(r.invoiceNo), 'mono-cell'),
        el('td', formatCellValue(r.supplierName)),
        el('td', formatCellValue(r.supplierGstin), 'mono-cell'),
        el('td', formatCellValue(r.invoiceDate), 'mono-cell'),
        el('td', formatMoney(r.total), 'num-col'),
        el('td', formatCellValue(r.description)),
        tdStatus,
        el('td', r.postedAt ? formatIST(r.postedAt) : '—', 'mono-cell')
      );
      tbody.append(tr);
    }
    renderTableGrandTotal(tbody, {
      totalCols: 8,
      amountColIndex: 4,
      totalAmount: sumSearchTotal,
      label: `Grand Total (${records.length} ${records.length === 1 ? 'record' : 'records'})`,
      trailingText: 'INR',
    });
    setBanner('searchDbBanner', `Found ${total} record(s) in ledger · ${sourceLabel}`, 'success');
    renderPagination('searchDb', {
      page: data.page || targetPage,
      totalPages,
      total,
      limit: 50,
      onPageChange: (p) => executeDatabaseSearch(p),
    });
  } catch (err) {
    setBanner('searchDbBanner', err.message, 'error');
  }
}

if ($('btnSearchDb')) {
  $('btnSearchDb').addEventListener('click', () => executeDatabaseSearch(1));
}

if ($('inputSearchDb')) {
  $('inputSearchDb').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      executeDatabaseSearch(1);
    }
  });
}

if ($('btnClearSearchDb')) {
  $('btnClearSearchDb').addEventListener('click', () => {
    if ($('inputSearchDb')) $('inputSearchDb').value = '';
    if ($('searchDbWrap')) $('searchDbWrap').classList.add('hidden');
    if ($('searchDbPagination')) $('searchDbPagination').classList.add('hidden');
    if ($('searchDbTableBody')) $('searchDbTableBody').textContent = '';
    setBanner('searchDbBanner', '');
  });
}

if ($('btnCheckAllS4')) {
  $('btnCheckAllS4').addEventListener('click', async () => {
    closeAllDropdowns();
    if (!state.s4List.length) {
      setS4SourceChip('uploaded');
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
      const data = (await parseJsonResponse(res)) || {};
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
      const data = (await parseJsonResponse(res)) || {};
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

// S/4 Segmented Status Filter, Search & Export Handlers
function setS4StatusFilter(statusVal) {
  const clean = String(statusVal || 'ALL').toUpperCase();
  if ($('s4FilterStatus')) {
    $('s4FilterStatus').value = clean;
  }
  const seg = $('s4StatusSegmented');
  if (seg) {
    seg.querySelectorAll('.seg-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.status === clean);
    });
  }
}

if ($('s4StatusSegmented')) {
  $('s4StatusSegmented').querySelectorAll('.seg-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      setS4StatusFilter(btn.dataset.status);
      loadS4Results(1);
    });
  });
}

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
    setS4StatusFilter($('s4FilterStatus').value);
    loadS4Results(1);
  });
}

async function downloadS4Csv() {
  closeAllDropdowns();
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
  closeAllDropdowns();
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
// REVIEW QUEUE PAGE & RIGHT-SIDE DECISION DRAWER
// ============================================================================
function openReviewDecisionDrawer(alert) {
  state.activeReviewAlert = alert;
  const drawer = $('reviewDecisionDrawer');
  const backdrop = $('reviewDrawerBackdrop');
  const titleEl = $('reviewDrawerTitle');
  const subEl = $('reviewDrawerSubtitle');
  const detailsEl = $('reviewDrawerDetails');
  const selectEl = $('reviewDecisionSelect');
  const commentEl = $('reviewDecisionComment');
  const errEl = $('reviewDrawerError');

  if (!drawer || !detailsEl) return;

  const invNo = formatCellValue(alert.invoiceNo);
  const supp = formatCellValue(alert.supplierName);
  const issueLabel = formatCellValue(alert.ruleName || alert.issue || alert.title);
  const tierVal = alert.tier || 'HOLD';

  if (titleEl) titleEl.textContent = `Review invoice ${invNo}`;
  if (subEl) subEl.textContent = supp;
  if (errEl) {
    errEl.textContent = '';
    errEl.classList.add('hidden');
  }
  if (commentEl) commentEl.value = '';

  if (selectEl) {
    selectEl.textContent = '';
    const optConfirm = el('option', 'Confirm issue');
    optConfirm.value = 'CONFIRM';
    selectEl.appendChild(optConfirm);
    if (tierVal !== 'REJECT') {
      const optClear = el('option', 'Clear issue');
      optClear.value = 'CLEAR';
      selectEl.appendChild(optClear);
    }
    const optEscalate = el('option', 'Escalate');
    optEscalate.value = 'ESCALATE';
    selectEl.appendChild(optEscalate);
    selectEl.value = 'CONFIRM';
  }

  detailsEl.textContent = '';
  detailsEl.appendChild(el('div', 'Alert summary', 'drawer-section-title'));
  const kvGrid = el('div', null, 'drawer-kv-grid');
  const addKv = (label, valNodeOrStr) => {
    kvGrid.appendChild(el('div', label, 'drawer-kv-label'));
    const valWrap = el('div', null, 'drawer-kv-val');
    if (typeof valNodeOrStr === 'string') {
      valWrap.textContent = valNodeOrStr;
    } else if (valNodeOrStr) {
      valWrap.appendChild(valNodeOrStr);
    }
    kvGrid.appendChild(valWrap);
  };
  addKv('Status', el('span', tierVal, `badge ${tierVal}`));
  addKv('Invoice No', invNo);
  addKv('Supplier', supp);
  addKv('Issue', issueLabel);
  addKv('Reason', cleanReasonDisplayText(alert.reason || alert.text));
  if (alert.createdAt) {
    addKv('Raised at', formatIST(alert.createdAt));
  }
  if (alert.decidedAt) {
    addKv('Decided at', formatIST(alert.decidedAt));
  }
  detailsEl.appendChild(kvGrid);

  drawer.classList.remove('hidden');
  if (backdrop) backdrop.classList.remove('hidden');
  if (commentEl) setTimeout(() => commentEl.focus(), 50);
}

function closeReviewDecisionDrawer() {
  state.activeReviewAlert = null;
  if ($('reviewDecisionDrawer')) $('reviewDecisionDrawer').classList.add('hidden');
  if ($('reviewDrawerBackdrop')) $('reviewDrawerBackdrop').classList.add('hidden');
}

if ($('btnCloseReviewDrawer')) {
  $('btnCloseReviewDrawer').addEventListener('click', closeReviewDecisionDrawer);
}
if ($('btnCancelReviewDrawer')) {
  $('btnCancelReviewDrawer').addEventListener('click', closeReviewDecisionDrawer);
}
if ($('reviewDrawerBackdrop')) {
  $('reviewDrawerBackdrop').addEventListener('click', closeReviewDecisionDrawer);
}

if ($('btnSaveReviewDecision')) {
  $('btnSaveReviewDecision').addEventListener('click', async () => {
    const alert = state.activeReviewAlert;
    if (!alert) return;
    const selectEl = $('reviewDecisionSelect');
    const commentEl = $('reviewDecisionComment');
    const errEl = $('reviewDrawerError');
    const decision = selectEl ? selectEl.value : 'CONFIRM';
    const comment = commentEl ? commentEl.value.trim() : '';

    if (!comment) {
      if (errEl) {
        errEl.textContent = 'A comment is required for every decision.';
        errEl.classList.remove('hidden');
      }
      if (commentEl) commentEl.focus();
      return;
    }

    try {
      $('btnSaveReviewDecision').disabled = true;
      await api('decideAlert', { alertId: alert.ID, decision, comment });
      closeReviewDecisionDrawer();
      setBanner('alertsBanner', `Decision saved (${decision}).`, 'success');
      showToast(`Decision saved for invoice ${formatCellValue(alert.invoiceNo)}.`, 'success');
      await loadAlertsQueue(state.alertsPage);
      loadTopSummary();
    } catch (err) {
      if (errEl) {
        errEl.textContent = err.message;
        errEl.classList.remove('hidden');
      }
    } finally {
      $('btnSaveReviewDecision').disabled = false;
    }
  });
}

async function loadAlertsQueue(page = 1) {
  state.alertsPage = page;
  const status = $('filterAlertsStatus') ? $('filterAlertsStatus').value : 'ALL';
  if ($('alertsTableBody') && (!state.alertsList || state.alertsList.length === 0)) {
    renderTableSkeleton($('alertsTableBody'), 6, 4);
  }
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
    const data = await parseJsonResponse(res);
    if (!data) return;
    state.alertsList = data.rows || [];
    state.alertsTotal = data.total || 0;
    state.alertsTotalPages = data.totalPages || 1;
    state.alertsCounts = data.counts || { open: 0, hold: 0, reject: 0 };

    if ($('alertsCountOpen')) $('alertsCountOpen').textContent = state.alertsCounts.open;
    if ($('alertsCountHold')) $('alertsCountHold').textContent = state.alertsCounts.hold;
    if ($('alertsCountReject')) $('alertsCountReject').textContent = state.alertsCounts.reject;

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
  const colCount = canDecide ? 6 : 5;

  if (!state.alertsList.length) {
    renderEmptyTableState(
      tbody,
      colCount,
      'No open alerts match the selected filter.',
      'Show all',
      () => {
        if ($('filterAlertsStatus')) $('filterAlertsStatus').value = 'ALL';
        loadAlertsQueue(1);
      }
    );
    return;
  }

  for (const alert of state.alertsList) {
    const tr = document.createElement('tr');
    const issueLabel = formatCellValue(alert.ruleName || alert.issue || alert.title || 'Invoice rule check');
    const tdReason = createClampedReasonCell(alert.reason || alert.text || '—');

    const tdStatus = document.createElement('td');
    tdStatus.appendChild(el('span', alert.tier || 'HOLD', `badge ${alert.tier || 'HOLD'}`));

    tr.append(
      el('td', formatCellValue(alert.invoiceNo), 'mono-cell'),
      el('td', formatCellValue(alert.supplierName)),
      el('td', issueLabel),
      tdReason,
      tdStatus
    );

    if (canDecide) {
      const tdActions = document.createElement('td');
      if (alert.decision === 'OPEN') {
        const btnReview = el('button', 'Review', 'primary btn-sm');
        btnReview.type = 'button';
        btnReview.addEventListener('click', () => openReviewDecisionDrawer(alert));
        tdActions.appendChild(btnReview);
      } else {
        const decidedText = alert.comment
          ? `${alert.decision}: ${alert.comment}`
          : `${alert.decision}`;
        tdActions.appendChild(el('span', decidedText, 'hint'));
      }
      tr.appendChild(tdActions);
    }

    tbody.appendChild(tr);
  }
  renderTableGrandTotal(tbody, {
    totalCols: colCount,
    amountColIndex: -1,
    label: 'Grand Total (Review Queue)',
    trailingText: `${state.alertsList.length} ${state.alertsList.length === 1 ? 'alert' : 'alerts'}`,
  });
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

  if ($('historyTableBody') && (!state.historyList || state.historyList.length === 0)) {
    renderTableSkeleton($('historyTableBody'), 7, 4);
  }

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
    const data = await parseJsonResponse(res);
    if (!data) return;
    state.historyList = data.rows || [];
    state.historyTotal = data.total || 0;
    state.historyTotalPages = data.totalPages || 1;
    state.historyCounts = data.counts || {
      total: state.historyTotal,
      pass: 0,
      hold: 0,
      reject: 0,
    };

    if ($('historyCountTotal')) $('historyCountTotal').textContent = state.historyCounts.total;
    if ($('historyCountPass')) $('historyCountPass').textContent = state.historyCounts.pass;
    if ($('historyCountHold')) $('historyCountHold').textContent = state.historyCounts.hold;
    if ($('historyCountReject')) $('historyCountReject').textContent = state.historyCounts.reject;

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
    renderEmptyTableState(
      tbody,
      7,
      'No check records match the current filter.',
      'Clear filters',
      () => {
        if ($('btnClearHistoryFilter')) $('btnClearHistoryFilter').click();
      }
    );
    return;
  }

  let sumHistoryTotal = 0;
  for (const r of state.historyList) {
    const tr = document.createElement('tr');
    const timeStr = r.createdAt ? formatIST(r.createdAt) : '—';
    const fileStr = formatCellValue(r.fileName || r.source);
    const invNoStr = formatCellValue(r.invoiceNo);
    const suppName = formatCellValue(r.supplierName);
    const gstinStr = formatCellValue(r.supplierGstin);
    const suppCellText = gstinStr !== '—' ? `${suppName} (${gstinStr})` : suppName;

    const numAmt = Number(r.total);
    if (!Number.isNaN(numAmt)) sumHistoryTotal += numAmt;

    const tdSt = document.createElement('td');
    tdSt.appendChild(el('span', r.status || 'PASS', `badge ${r.status || 'PASS'}`));

    tr.append(
      el('td', timeStr, 'mono-cell'),
      el('td', fileStr),
      el('td', invNoStr, 'mono-cell'),
      el('td', suppCellText),
      el('td', formatMoney(r.total), 'num-col'),
      tdSt,
      el('td', formatReviewerName(r.createdBy))
    );
    tr.className = 'clickable-row';
    tr.tabIndex = 0;
    tr.addEventListener('click', () => openS4DetailDrawer(r, 'history'));
    tr.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        openS4DetailDrawer(r, 'history');
      }
    });
    tbody.append(tr);
  }
  renderTableGrandTotal(tbody, {
    totalCols: 7,
    amountColIndex: 4,
    totalAmount: sumHistoryTotal,
    label: `Grand Total (${state.historyList.length} ${state.historyList.length === 1 ? 'check' : 'checks'})`,
    trailingText: 'INR',
  });
}

if ($('filterHistoryLimit')) {
  $('filterHistoryLimit').addEventListener('change', () => {
    loadCheckHistory(1);
  });
}

if ($('filterHistoryStatus')) {
  $('filterHistoryStatus').addEventListener('change', () => {
    loadCheckHistory(1);
  });
}

if ($('btnApplyHistoryFilter')) {
  $('btnApplyHistoryFilter').addEventListener('click', () => {
    loadCheckHistory(1);
  });
}

if ($('btnClearHistoryFilter')) {
  $('btnClearHistoryFilter').addEventListener('click', () => {
    if ($('filterHistoryStatus')) $('filterHistoryStatus').value = 'ALL';
    if ($('filterHistoryFrom')) $('filterHistoryFrom').value = '';
    if ($('filterHistoryTo')) $('filterHistoryTo').value = '';
    if ($('filterHistorySupplier')) $('filterHistorySupplier').value = '';
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
// ACTIVITY LOG PAGE & UNIFIED SERVER-SIDE COUNT
// ============================================================================
function parseAuditDetail(detailStr, action = '') {
  const s = String(detailStr || '');
  const uMatch = s.match(/\[user=([^\]]*)\]/);
  const fMatch = s.match(/\[file=([^\]]*)\]/);
  const rMatch = s.match(/\[result=([^\]]*)\]/);
  const clean = s
    .replace(/\[(?:user|file|result)=[^\]]*\]/g, '')
    .replace(/\b(sandbox|demo data)\b/gi, '')
    .trim();
  const rawUser = uMatch ? uMatch[1] : 'System';
  const user = formatReviewerName(rawUser);
  return {
    user,
    file: formatCellValue(fMatch ? fMatch[1] : ''),
    result: formatCellValue(rMatch ? rMatch[1] : clean),
    clean: formatCellValue(clean),
  };
}

function setActivityViewMode(mode) {
  state.activityView = mode === 'ALL' ? 'ALL' : 'CHECKS';
  const lbl = $('activityShowingLabel');
  if (lbl) {
    lbl.textContent = state.activityView === 'CHECKS' ? 'Showing: Checks only' : 'Showing: All events';
  }
  if ($('btnActivityViewChecks')) {
    $('btnActivityViewChecks').classList.toggle('active', state.activityView === 'CHECKS');
  }
  if ($('btnActivityViewAll')) {
    $('btnActivityViewAll').classList.toggle('active', state.activityView === 'ALL');
  }
}

if ($('btnActivityViewChecks')) {
  $('btnActivityViewChecks').addEventListener('click', () => {
    if ($('filterActivityAction')) $('filterActivityAction').value = 'ALL';
    setActivityViewMode('CHECKS');
    loadActivityLog(1);
  });
}

if ($('btnActivityViewAll')) {
  $('btnActivityViewAll').addEventListener('click', () => {
    setActivityViewMode('ALL');
    loadActivityLog(1);
  });
}

async function loadActivityLog(page = 1) {
  state.activityPage = page;
  const action = $('filterActivityAction') ? $('filterActivityAction').value : 'ALL';
  if (action && action !== 'ALL' && action !== 'CHAT_CHECK') {
    setActivityViewMode('ALL');
  }

  if ($('activityTableBody') && (!state.activityList || state.activityList.length === 0)) {
    renderTableSkeleton($('activityTableBody'), 5, 4);
  }

  try {
    const params = new URLSearchParams({
      page: String(page),
      limit: '50',
      action: action || 'ALL',
      view: state.activityView || 'CHECKS',
    });
    const [logRes, chain] = await Promise.all([
      fetch(`/fraud/activityLogs?${params.toString()}`, { method: 'GET', headers: getHeaders() }),
      api('verifyAuditChain', null, 'GET'),
    ]);

    let unifiedCount = chain && chain.entries !== undefined ? Number(chain.entries) : 0;

    const logParsed = await parseJsonResponse(logRes);
    if (logParsed) {
      const data = logParsed;
      state.activityList = data.rows || [];
      state.activityTotal = data.total || 0;
      state.activityTotalPages = data.totalPages || 1;
      if (data.checksTotal !== undefined) {
        unifiedCount = Number(data.checksTotal);
      }
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
        badge.className = 'integrity-chip';
        badge.textContent = `Audit chain verified · ${unifiedCount} entries`;
      } else {
        badge.className = 'integrity-chip error';
        badge.textContent = `Audit chain broken at entry #${chain.brokenAt}`;
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
    renderEmptyTableState(
      tbody,
      5,
      'No activity log entries match the selected filter.',
      'Show all checks',
      () => {
        if ($('filterActivityAction')) $('filterActivityAction').value = 'ALL';
        setActivityViewMode('CHECKS');
        loadActivityLog(1);
      }
    );
    return;
  }

  for (const row of state.activityList) {
    const parsed = parseAuditDetail(row.detail, row.action);
    const tr = document.createElement('tr');
    const timeStr = row.ts ? formatIST(row.ts) : '—';
    const actionLabel = formatActionPlainWord(row.action);
    const fileOrSource = formatCellValue(row.fileName || parsed.file);

    const tdResult = document.createElement('td');
    const upperRes = String(row.status || parsed.result || '').toUpperCase();
    if (upperRes === 'PASS' || upperRes === 'HOLD' || upperRes === 'REJECT') {
      tdResult.appendChild(el('span', upperRes, `badge ${upperRes}`));
      if (row.invoiceNo && row.invoiceNo !== '—') {
        const sub = el('span', ` ${row.invoiceNo}`, 'mono-cell');
        sub.style.marginLeft = '6px';
        tdResult.appendChild(sub);
      }
    } else {
      tdResult.textContent = parsed.clean !== '—' ? parsed.clean : parsed.result;
    }

    const byText = formatReviewerName(row.createdBy || parsed.user);

    tr.append(
      el('td', timeStr, 'mono-cell'),
      el('td', actionLabel),
      el('td', fileOrSource, 'mono-cell'),
      tdResult,
      el('td', byText)
    );
    tbody.append(tr);
  }
  renderTableGrandTotal(tbody, {
    totalCols: 5,
    amountColIndex: -1,
    label: 'Grand Total (Activity Log)',
    trailingText: `${state.activityList.length} ${state.activityList.length === 1 ? 'entry' : 'entries'}`,
  });
}

if ($('filterActivityAction')) {
  $('filterActivityAction').addEventListener('change', () => {
    const val = $('filterActivityAction').value;
    if (val && val !== 'ALL') {
      setActivityViewMode('ALL');
    }
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
    const headers = ['Time', 'Action', 'File or source', 'Result', 'By'];
    const escapeCsv = (v) => `"${String(v || '').replace(/"/g, '""')}"`;
    const lines = [headers.join(',')];
    for (const row of state.activityList) {
      const parsed = parseAuditDetail(row.detail, row.action);
      const actionPlain = formatActionPlainWord(row.action);
      const fileSource = formatCellValue(row.fileName || parsed.file);
      const resVal = parsed.clean !== '—' ? parsed.clean : parsed.result;
      const byVal = formatReviewerName(row.createdBy || parsed.user);
      const timeVal = row.ts ? formatIST(row.ts) : '—';
      lines.push([timeVal, actionPlain, fileSource, resVal, byVal].map(escapeCsv).join(','));
    }
    triggerDownload('\uFEFF' + lines.join('\r\n'), 'blus-invoice-agent-activity-log.csv', 'text/csv;charset=utf-8');
  });
}

async function downloadActivityExcel() {
  const action = $('filterActivityAction') ? $('filterActivityAction').value : 'ALL';
  const view = state.activityView || 'CHECKS';
  const r = await fetch('/fraud/exportActivityExcel', {
    method: 'POST',
    headers: getHeaders(),
    body: JSON.stringify({ action, view }),
  });
  if (!r.ok) {
    throw new Error(`Activity Log Excel download failed (${r.status})`);
  }
  const xlsxArrayBuffer = await r.arrayBuffer();
  const xlsxBlob = new Blob([xlsxArrayBuffer], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
  triggerDownload(
    xlsxBlob,
    'blus-invoice-agent-activity-log.xlsx',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  );
}

if ($('btnExportActivityExcel')) {
  $('btnExportActivityExcel').addEventListener('click', () => {
    downloadActivityExcel().catch(err => {
      console.error(err);
      showToast(err.message, 'error');
    });
  });
}

// ============================================================================
// PART 1 & PART 5: TOP SUMMARY BAR & FAILED TO READ DRAWER
// ============================================================================
async function loadTopSummary() {
  try {
    let res = await fetch('/fraud/summary', {
      method: 'GET',
      headers: getHeaders(),
    });
    let data = await parseJsonResponse(res);

    // If /fraud/summary returned non-JSON (e.g. gateway redirect or HTML error), try OData function fallback
    if (!data) {
      const odataRes = await fetch('/fraud/getSummary()', {
        method: 'GET',
        headers: getHeaders(),
      });
      const odataParsed = await parseJsonResponse(odataRes);
      if (odataParsed) {
        const val = odataParsed.value !== undefined ? odataParsed.value : odataParsed;
        if (typeof val === 'string') {
          try {
            data = JSON.parse(val);
          } catch {
            data = null;
          }
        } else if (val && typeof val === 'object') {
          data = val;
        }
      }
    }

    if (!data) return;

    state.topSummary = {
      uploaded: Number(data.uploaded || 0),
      savedToLedger: Number(data.savedToLedger || 0),
      passed: Number(data.passed || 0),
      held: Number(data.held || 0),
      rejected: Number(data.rejected || 0),
      failedToRead: Number(data.failedToRead || 0),
      failedFiles: Array.isArray(data.failedFiles) ? data.failedFiles : [],
      consistent: data.consistent !== false,
      consistencyWarning: data.consistencyWarning || null,
    };
    renderTopSummary();
  } catch (err) {
    console.warn('Top summary unavailable:', err && err.message ? err.message : err);
  }
}

function renderTopSummary() {
  const s = state.topSummary || {};
  const setVal = (id, val) => {
    const node = $(id);
    if (node) node.textContent = String(val ?? 0);
  };

  // Upload invoice tab summary numbers
  setVal('uploadSummaryUploaded', s.uploaded);
  setVal('uploadSummarySavedToLedger', s.savedToLedger);
  setVal('uploadSummaryPassed', s.passed);
  setVal('uploadSummaryHeld', s.held);
  setVal('uploadSummaryRejected', s.rejected);
  setVal('uploadSummaryFailed', s.failedToRead);

  // S/4HANA extract tab summary numbers
  setVal('s4SummaryUploaded', s.uploaded);
  setVal('s4SummarySavedToLedger', s.savedToLedger);
  setVal('s4SummaryPassed', s.passed);
  setVal('s4SummaryHeld', s.held);
  setVal('s4SummaryRejected', s.rejected);
  setVal('s4SummaryFailed', s.failedToRead);

  // Part 5: Show "Count check failed: see Activity log." ONLY when numbers do not match
  const isInconsistent = s.consistent === false;
  if ($('uploadSummaryConsistencyWarn')) {
    $('uploadSummaryConsistencyWarn').classList.toggle('hidden', !isInconsistent);
  }
  if ($('s4SummaryConsistencyWarn')) {
    $('s4SummaryConsistencyWarn').classList.toggle('hidden', !isInconsistent);
  }
}

function openFailedReadsDrawer() {
  const drawer = $('failedReadsDrawer');
  const backdrop = $('failedReadsBackdrop');
  const bodyEl = $('failedReadsDrawerBody');
  if (!drawer || !bodyEl) return;

  bodyEl.textContent = '';
  const failedFiles = (state.topSummary && Array.isArray(state.topSummary.failedFiles))
    ? state.topSummary.failedFiles
    : [];

  if (failedFiles.length === 0) {
    bodyEl.appendChild(el('div', 'No files failed to read in this session.', 'hint'));
  } else {
    const listWrap = el('div', null, 'failed-reads-list');
    failedFiles.forEach(item => {
      const card = el('div', null, 'failed-read-card');
      const fileHeader = item.ts
        ? `${formatCellValue(item.fileName || 'invoice')} · ${formatIST(item.ts)}`
        : formatCellValue(item.fileName || 'invoice');
      card.append(
        el('div', fileHeader, 'failed-read-file'),
        el('div', formatCellValue(item.reason || 'No readable text found. Try a clearer scan or a Fiori CSV export.'), 'failed-read-reason')
      );
      listWrap.appendChild(card);
    });
    bodyEl.appendChild(listWrap);
  }

  drawer.classList.remove('hidden');
  if (backdrop) backdrop.classList.remove('hidden');
}

function closeFailedReadsDrawer() {
  if ($('failedReadsDrawer')) $('failedReadsDrawer').classList.add('hidden');
  if ($('failedReadsBackdrop')) $('failedReadsBackdrop').classList.add('hidden');
}

if ($('btnCloseFailedReadsDrawer')) {
  $('btnCloseFailedReadsDrawer').addEventListener('click', closeFailedReadsDrawer);
}
if ($('failedReadsBackdrop')) {
  $('failedReadsBackdrop').addEventListener('click', closeFailedReadsDrawer);
}

document.querySelectorAll('.summary-metric-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const action = btn.dataset.summaryAction;
    if (action === 'ledger') {
      switchPage('ledger');
    } else if (action === 'held') {
      if ($('filterAlertsStatus')) $('filterAlertsStatus').value = 'HOLD';
      switchPage('alerts');
      loadAlertsQueue(1);
    } else if (action === 'rejected') {
      if ($('filterAlertsStatus')) $('filterAlertsStatus').value = 'REJECT';
      switchPage('alerts');
      loadAlertsQueue(1);
    } else if (action === 'failed') {
      openFailedReadsDrawer();
    } else if (action === 'passed') {
      if ($('filterHistoryStatus')) $('filterHistoryStatus').value = 'PASS';
      switchPage('history');
      loadCheckHistory(1);
    } else if (action === 'uploaded') {
      if ($('filterHistoryStatus')) $('filterHistoryStatus').value = 'ALL';
      switchPage('history');
      loadCheckHistory(1);
    }
  });
});

// ============================================================================
// PART 2: LEDGER VIEW (HANA ap.Posted)
// ============================================================================
async function loadLedgerView(page = 1) {
  state.ledgerPage = page;
  const search = $('ledgerSearchInput') ? $('ledgerSearchInput').value.trim() : '';

  if ($('ledgerTableBody') && (!state.ledgerList || state.ledgerList.length === 0)) {
    renderTableSkeleton($('ledgerTableBody'), 8, 4);
  }

  try {
    const params = new URLSearchParams({
      page: String(page),
      limit: '50',
      search,
    });
    const res = await fetch(`/fraud/ledger?${params.toString()}`, {
      method: 'GET',
      headers: getHeaders(),
    });
    const data = await parseJsonResponse(res);
    if (!data) return;
    state.ledgerList = data.rows || [];
    state.ledgerTotal = Number(data.total || 0);
    state.ledgerTotalPages = Number(data.totalPages || 1);

    if ($('ledgerSourceBadge') && data.source) {
      $('ledgerSourceBadge').textContent = data.source;
    }

    renderLedgerTable();
    renderPagination('ledger', {
      page: state.ledgerPage,
      totalPages: state.ledgerTotalPages,
      total: state.ledgerTotal,
      limit: 50,
      onPageChange: (p) => loadLedgerView(p),
    });
  } catch (err) {
    console.error('Failed to load ledger view:', err);
  }
}

function renderLedgerTable() {
  const tbody = $('ledgerTableBody');
  if (!tbody) return;
  tbody.textContent = '';

  if (!state.ledgerList || state.ledgerList.length === 0) {
    renderEmptyTableState(
      tbody,
      8,
      'No invoices saved to the ledger yet. Passed invoices are saved automatically.'
    );
    return;
  }

  let sumLedgerTotal = 0;
  for (const r of state.ledgerList) {
    const tr = document.createElement('tr');
    tr.className = 'clickable-row';
    tr.tabIndex = 0;
    const amt = r.amountInr !== undefined && r.amountInr !== null ? r.amountInr : r.total;
    const numAmt = Number(amt);
    if (!Number.isNaN(numAmt)) sumLedgerTotal += numAmt;

    tr.append(
      el('td', formatCellValue(r.invoiceNo), 'mono-cell'),
      el('td', formatCellValue(r.supplierName)),
      el('td', formatCellValue(r.supplierGstin), 'mono-cell'),
      el('td', formatCellValue(r.invoiceDate), 'mono-cell'),
      el('td', r.postedAt ? formatIST(r.postedAt) : formatCellValue(r.postingDate), 'mono-cell'),
      el('td', formatMoney(amt), 'num-col'),
      el('td', formatCellValue(r.fiscalYear), 'mono-cell'),
      el('td', formatCellValue(r.source || 'Import'))
    );
    tr.addEventListener('click', () => openS4DetailDrawer(r, 'ledger'));
    tr.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        openS4DetailDrawer(r, 'ledger');
      }
    });
    tbody.appendChild(tr);
  }
  renderTableGrandTotal(tbody, {
    totalCols: 8,
    amountColIndex: 5,
    totalAmount: sumLedgerTotal,
    label: `Grand Total (${state.ledgerList.length} ${state.ledgerList.length === 1 ? 'invoice' : 'invoices'})`,
    trailingText: 'INR',
  });
}

if ($('btnLedgerSearch')) {
  $('btnLedgerSearch').addEventListener('click', () => loadLedgerView(1));
}

if ($('ledgerSearchInput')) {
  $('ledgerSearchInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      loadLedgerView(1);
    }
  });
}

if ($('btnLedgerClear')) {
  $('btnLedgerClear').addEventListener('click', () => {
    if ($('ledgerSearchInput')) $('ledgerSearchInput').value = '';
    loadLedgerView(1);
  });
}

async function downloadLedgerCsv() {
  const search = $('ledgerSearchInput') ? $('ledgerSearchInput').value.trim() : '';
  const r = await fetch('/fraud/exportLedgerCsv', {
    method: 'POST',
    headers: getHeaders(),
    body: JSON.stringify({ search }),
  });
  if (!r.ok) throw new Error(`Ledger CSV download failed (${r.status})`);
  const rawText = await r.text();
  const csvWithBom = rawText.startsWith('\uFEFF') ? rawText : '\uFEFF' + rawText;
  triggerDownload(csvWithBom, 'blus-invoice-agent-ledger.csv', 'text/csv;charset=utf-8');
}

async function downloadLedgerExcel() {
  const search = $('ledgerSearchInput') ? $('ledgerSearchInput').value.trim() : '';
  const r = await fetch('/fraud/exportLedgerExcel', {
    method: 'POST',
    headers: getHeaders(),
    body: JSON.stringify({ search }),
  });
  if (!r.ok) throw new Error(`Ledger Excel download failed (${r.status})`);
  const xlsxArrayBuffer = await r.arrayBuffer();
  const xlsxBlob = new Blob([xlsxArrayBuffer], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
  triggerDownload(
    xlsxBlob,
    'blus-invoice-agent-ledger.xlsx',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  );
}

if ($('btnExportLedgerCsv')) {
  $('btnExportLedgerCsv').addEventListener('click', () => {
    downloadLedgerCsv().catch(err => {
      console.error(err);
      showToast(err.message, 'error');
    });
  });
}

if ($('btnExportLedgerExcel')) {
  $('btnExportLedgerExcel').addEventListener('click', () => {
    downloadLedgerExcel().catch(err => {
      console.error(err);
      showToast(err.message, 'error');
    });
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
    // Single user mode: all roles granted, full access to all tabs and actions
    state.roles = ['APClerk', 'APController', 'Auditor'];
    state.user = 'user';
  }

  applyRolePermissions();
  loadTopSummary();
}

initApp();


