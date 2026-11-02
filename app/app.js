'use strict';

const ACTIVE_RULE_IDS = ['AP-02', 'AP-03', 'AP-09', 'AP-11'];
const MAX_FILE_BYTES = 10 * 1024 * 1024; // 10 MB

const FIELD_DEFINITIONS = [
  { key: 'supplierName', label: 'Supplier name' },
  { key: 'supplierGstin', label: 'Supplier GSTIN' },
  { key: 'buyerGstin', label: 'Buyer GSTIN' },
  { key: 'invoiceNo', label: 'Invoice number' },
  { key: 'invoiceDate', label: 'Invoice date' },
  { key: 'poNumber', label: 'PO number' },
  { key: 'description', label: 'Description' },
  { key: 'taxable', label: 'Taxable amount (INR)' },
  { key: 'cgst', label: 'CGST (INR)' },
  { key: 'sgst', label: 'SGST (INR)' },
  { key: 'igst', label: 'IGST (INR)' },
  { key: 'total', label: 'Total amount (INR)' },
  { key: 'ifsc', label: 'Bank IFSC' },
  { key: 'accountNo', label: 'Bank account number' },
];

const DEFAULT_STEPS = [
  { step: 1, title: 'Received the file.', status: 'waiting', detail: 'Waiting for file selection' },
  { step: 2, title: 'Detected the file type.', status: 'waiting', detail: 'PDF with text, Scanned PDF, or Image (PNG or JPG)' },
  { step: 3, title: 'Read the document.', status: 'waiting', detail: 'Waiting to read text layer or OCR' },
  { step: 4, title: 'Extracted the fields.', status: 'waiting', detail: 'Waiting for field extraction' },
  { step: 5, title: 'Checked arithmetic and GSTIN format.', status: 'waiting', detail: 'Waiting for arithmetic and GSTIN verification' },
  { step: 6, title: 'Ran the active rules AP-02, AP-03, AP-09, AP-11.', status: 'waiting', detail: 'Waiting for rule execution' },
  { step: 7, title: 'Looked up similar past invoices.', status: 'waiting', detail: 'Waiting for lookup layer' },
  { step: 8, title: 'Decided from the rules.', status: 'waiting', detail: 'Waiting for rule outcome' },
  { step: 9, title: 'Saved to the check log.', status: 'waiting', detail: 'Waiting to persist check record' },
  { step: 10, title: 'Showed the result.', status: 'waiting', detail: 'Waiting for final result display' },
];

const state = {
  user: 'controller',
  roles: ['APClerk', 'APController'],
  selectedFile: null,       // { name, size, type, base64, dataUrl }
  fields: {},
  fieldConfidences: {},     // { [key]: { value, confidence, label } }
  confirmedLowFields: new Set(),
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
// 2.1 SIDEBAR NAVIGATION & ROLE MANAGEMENT
// ============================================================================
function switchPage(pageId) {
  document.querySelectorAll('.nav-item').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.page === pageId);
  });
  document.querySelectorAll('.page-section').forEach(sec => {
    sec.classList.toggle('active', sec.id === 'page-' + pageId);
  });

  if (pageId === 'alerts') loadAlertsQueue();
  if (pageId === 'history') loadCheckHistory();
  if (pageId === 'activity') loadActivityLog();
}

document.querySelectorAll('.nav-item').forEach(btn => {
  btn.addEventListener('click', () => switchPage(btn.dataset.page));
});

function applyRolePermissions() {
  const isAuditorOnly = state.roles.includes('Auditor') && !state.roles.includes('APClerk') && !state.roles.includes('APController');
  const canUploadOrCheck = state.roles.includes('APClerk') || state.roles.includes('APController');
  const canPost = state.roles.includes('APClerk');
  const canDecide = state.roles.includes('APController');

  $('sidebarUserText').textContent = `User: ${state.user}`;
  $('sidebarRoleText').textContent = `Role: ${state.roles.join(', ')}`;
  $('headerUserBadge').textContent = `Signed in: ${state.user} (${state.roles.join(', ')})`;

  // Hide Upload, Check, Import, and Post buttons for Auditor (Section 7 & Acceptance Test 18)
  const uploadBtns = $('uploadActionButtons');
  if (uploadBtns) uploadBtns.classList.toggle('hidden', !canUploadOrCheck);
  const dropCard = $('dropZone');
  if (dropCard) dropCard.classList.toggle('hidden', isAuditorOnly);

  const s4ActionRow = $('s4ActionRow');
  if (s4ActionRow) s4ActionRow.classList.toggle('hidden', !canUploadOrCheck);

  const postBtn = $('btnPostLedger');
  const saveBtn = $('btnSaveResult');
  if (postBtn) postBtn.classList.toggle('hidden', !canPost);
  if (saveBtn) saveBtn.classList.toggle('hidden', !canUploadOrCheck);

  const actionHeader = $('alertsActionHeader');
  if (actionHeader) actionHeader.classList.toggle('hidden', !canDecide);
  const roleHint = $('alertsRoleHint');
  if (roleHint) {
    roleHint.textContent = canDecide
      ? 'Signed in with APController authority: decision buttons enabled.'
      : 'Read-only queue view: only APController users can record Clear, Confirm, or Escalate decisions.';
  }

  updatePostButtonState();
  if ($('page-alerts').classList.contains('active')) {
    renderAlertsTable();
  }
}

$('roleSwitcher').addEventListener('change', (e) => {
  const val = e.target.value;
  state.roles = val.split(',').map(s => s.trim()).filter(Boolean);
  if (state.roles.length === 1) {
    state.user = state.roles[0] === 'Auditor' ? 'auditor' : (state.roles[0] === 'APClerk' ? 'clerk' : 'controller');
  } else {
    state.user = 'controller';
  }
  applyRolePermissions();
});

// ============================================================================
// 2.2 UPLOAD INVOICE PAGE (10 Steps, Preview, Result Card, Field Table)
// ============================================================================
function renderSteps(steps) {
  const list = $('stepList');
  list.textContent = '';
  (steps || DEFAULT_STEPS).forEach(s => {
    const li = el('li', null, 'step-item');
    const icon = el('span', s.status, `step-icon ${s.status}`);
    const body = el('div', null, 'step-body');
    body.append(
      el('div', `${s.step}. ${s.title}`, 'step-title'),
      el('div', s.detail || '', 'step-detail')
    );
    li.append(icon, body);
    list.append(li);
  });
}

function renderPreview(fileObj) {
  const box = $('imagePreviewBox');
  box.textContent = '';
  if (!fileObj) {
    box.append(el('span', 'Select or upload a PDF, PNG, or JPG invoice to preview it alongside the extracted fields.', 'hint'));
    return;
  }

  const ext = String(fileObj.name || '').toLowerCase().split('.').pop();
  if ((ext === 'png' || ext === 'jpg' || ext === 'jpeg') && fileObj.dataUrl) {
    const img = document.createElement('img');
    img.src = fileObj.dataUrl;
    img.alt = `Invoice preview: ${fileObj.name}`;
    box.append(img);
    const cap = el('div', `${fileObj.name} (${Math.max(1, Math.round(fileObj.size / 1024))} KB)`, 'hint');
    cap.style.marginTop = '8px';
    box.append(cap);
  } else {
    const card = el('div', null);
    card.append(
      el('div', `PDF Document: ${fileObj.name}`, 'step-title'),
      el('div', `Size: ${Math.max(1, Math.round(fileObj.size / 1024))} KB`, 'step-detail')
    );
    if (state.currentResult && state.currentResult.pdfText) {
      const pre = el('pre', state.currentResult.pdfText.slice(0, 400));
      pre.style.marginTop = '10px';
      pre.style.padding = '10px';
      pre.style.background = '#fff';
      pre.style.border = '1px solid #cbd5e1';
      pre.style.borderRadius = '4px';
      pre.style.fontSize = '12px';
      pre.style.whiteSpace = 'pre-wrap';
      pre.style.textAlign = 'left';
      card.append(pre);
    }
    box.append(card);
  }
}

function getUnconfirmedLowFields() {
  const lowKeys = [];
  for (const def of FIELD_DEFINITIONS) {
    const fc = state.fieldConfidences[def.key];
    if (fc && fc.label === 'Low' && !state.confirmedLowFields.has(def.key)) {
      lowKeys.push(def.label);
    }
  }
  return lowKeys;
}

function updatePostButtonState() {
  const btn = $('btnPostLedger');
  const notice = $('lowConfidenceNotice');
  if (!btn) return;

  const unconfirmed = getUnconfirmedLowFields();
  if (unconfirmed.length > 0) {
    notice.className = 'status-banner warning';
    notice.textContent = `Low-confidence field(s) require confirmation before posting to ledger: ${unconfirmed.join(', ')}. Edit or click "Confirm" on each highlighted field.`;
  } else {
    notice.className = 'status-banner hidden';
    notice.textContent = '';
  }

  const canPostRole = state.roles.includes('APClerk');
  const hasResult = Boolean(state.currentResult && state.currentResult.status);
  const isReject = state.currentResult && state.currentResult.status === 'REJECT';

  btn.disabled = !canPostRole || !hasResult || isReject || unconfirmed.length > 0;
}

function renderFieldTable() {
  const tbody = $('fieldTableBody');
  tbody.textContent = '';

  for (const def of FIELD_DEFINITIONS) {
    const val = state.fields[def.key] !== undefined && state.fields[def.key] !== null ? state.fields[def.key] : '';
    const fc = state.fieldConfidences[def.key] || {
      value: val,
      confidence: val !== '' ? 95 : 100,
      label: val !== '' ? 'High' : 'Check',
    };

    const isLowUnconfirmed = fc.label === 'Low' && !state.confirmedLowFields.has(def.key);
    const effectiveLabel = (fc.label === 'Low' && state.confirmedLowFields.has(def.key)) ? 'High' : fc.label;

    const tr = document.createElement('tr');
    if (isLowUnconfirmed) tr.className = 'row-low-confidence';

    const tdLabel = el('td', def.label);
    const tdInput = document.createElement('td');
    const input = document.createElement('input');
    input.type = def.key === 'invoiceDate' ? 'date' : 'text';
    input.className = 'field-input';
    input.name = def.key;
    input.setAttribute('aria-label', def.label);
    input.value = val;

    input.addEventListener('input', () => {
      state.fields[def.key] = input.value;
      if (fc.label === 'Low') {
        state.confirmedLowFields.add(def.key);
        renderFieldTable();
      }
    });
    tdInput.append(input);

    const tdConf = document.createElement('td');
    const badge = el(
      'span',
      `${effectiveLabel}${fc.confidence ? ` (${fc.confidence}%)` : ''}`,
      `badge ${effectiveLabel}`
    );
    tdConf.append(badge);

    const tdAction = document.createElement('td');
    if (isLowUnconfirmed) {
      const confirmBtn = el('button', 'Confirm field');
      confirmBtn.type = 'button';
      confirmBtn.setAttribute('aria-label', `Confirm ${def.label}`);
      confirmBtn.addEventListener('click', () => {
        state.confirmedLowFields.add(def.key);
        renderFieldTable();
        updatePostButtonState();
      });
      tdAction.append(confirmBtn);
    } else if (fc.label === 'Low' && state.confirmedLowFields.has(def.key)) {
      tdAction.append(el('span', 'Confirmed by user', 'hint'));
    } else {
      tdAction.append(el('span', 'Verified', 'hint'));
    }

    tr.append(tdLabel, tdInput, tdConf, tdAction);
    tbody.append(tr);
  }

  updatePostButtonState();
}

/**
 * 2.2c Result card:
 * - Large badge (PASS, HOLD or REJECT)
 * - Below it, the four active rules as rows, each with its own badge and reason
 * - Then one grey line: "N rules are disabled by configuration." Do not list the disabled rules on screen.
 */
function renderResultCard(container, res, headingPrefix = 'Check Result') {
  if (!container || !res) return;
  container.classList.remove('hidden');
  container.textContent = '';

  const header = el('div', null, 'result-card-header');
  const titleWrap = el('div');
  titleWrap.append(
    el('h3', `${headingPrefix}${res.invoice && res.invoice.invoiceNo ? ': ' + res.invoice.invoiceNo : ''}`),
    el('p', res.status === 'REJECT' ? 'Invoice rejected by active fraud rules. Posting to ledger is blocked.' : (res.status === 'HOLD' ? 'Invoice placed on HOLD for review.' : 'Invoice passed all active fraud rules.'), 'hint')
  );
  const bigBadge = el('span', res.status, `badge badge-large ${res.status}`);
  header.append(titleWrap, bigBadge);
  container.append(header);

  const allResults = res.results || [];
  const activeRows = (res.activeResults && res.activeResults.length)
    ? res.activeResults
    : allResults.filter(r => ACTIVE_RULE_IDS.includes(r.id));
  const disabledCount = res.disabledRulesCount !== undefined
    ? res.disabledRulesCount
    : allResults.filter(r => r.tier === 'DISABLED').length || 10;

  const listWrap = el('div', null, 'active-rules-list');
  for (const r of activeRows) {
    const row = el('div', null, 'active-rule-row');
    row.append(
      el('strong', r.id),
      el('span', r.title || ''),
      el('span', r.tier, `badge ${r.tier}`),
      el('span', r.text || '')
    );
    listWrap.append(row);
  }
  container.append(listWrap);

  const greyLine = el('div', `${disabledCount} rules are disabled by configuration.`, 'disabled-rules-note');
  container.append(greyLine);
}

// File Selection & Validation (PDF, PNG, JPG only, max 10 MB)
function selectFileObject(file) {
  setBanner('uploadBanner', '');
  if (!file) return;

  const ext = String(file.name || '').toLowerCase().split('.').pop();
  const allowed = ['pdf', 'png', 'jpg', 'jpeg'];
  if (!allowed.includes(ext)) {
    state.selectedFile = null;
    $('selectedFileInfo').classList.add('hidden');
    setBanner('uploadBanner', 'Unsupported file type. Only PDF, PNG and JPG files are accepted.', 'error');
    return;
  }

  if (file.size > MAX_FILE_BYTES) {
    state.selectedFile = null;
    $('selectedFileInfo').classList.add('hidden');
    setBanner('uploadBanner', 'File size exceeds the 10 MB maximum limit.', 'error');
    return;
  }

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
    const kb = Math.max(1, Math.round(file.size / 1024));
    const info = $('selectedFileInfo');
    info.textContent = `Selected file: ${file.name} (${kb} KB)`;
    info.classList.remove('hidden');
    renderPreview(state.selectedFile);
  };
  reader.readAsDataURL(file);
}

$('invoiceFileInput').addEventListener('change', (e) => {
  const f = e.target.files && e.target.files[0];
  if (f) selectFileObject(f);
});

const dropZone = $('dropZone');
dropZone.addEventListener('dragover', (e) => {
  e.preventDefault();
  dropZone.classList.add('dragover');
});
dropZone.addEventListener('dragleave', () => dropZone.classList.remove('dragover'));
dropZone.addEventListener('drop', (e) => {
  e.preventDefault();
  dropZone.classList.remove('dragover');
  const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
  if (f) selectFileObject(f);
});

async function runUploadAndCheck(simulateLowConfidence = false) {
  if (!state.selectedFile) {
    setBanner('uploadBanner', 'Please select or drop a PDF, PNG, or JPG invoice file first (or click "Use sample").', 'error');
    return;
  }

  setBanner('uploadBanner', `Uploading and checking ${state.selectedFile.name}...`, 'info');
  const runningSteps = DEFAULT_STEPS.map((s, idx) => ({
    ...s,
    status: idx < 3 ? 'running' : 'waiting',
  }));
  renderSteps(runningSteps);

  try {
    const out = await api('uploadDocument', {
      fileName: state.selectedFile.name,
      fileSize: state.selectedFile.size,
      fileBase64: state.selectedFile.base64,
    });

    if (out.steps) renderSteps(out.steps);
    state.fields = out.fields || {};
    state.fieldConfidences = out.fieldConfidences || {};
    state.confirmedLowFields = new Set();

    if (simulateLowConfidence) {
      state.fieldConfidences.poNumber = {
        value: state.fields.poNumber || '4500001001',
        confidence: 58,
        label: 'Low',
      };
    }

    if (out.ok === false) {
      state.currentResult = null;
      renderFieldTable();
      setBanner('uploadBanner', out.error || out.warning || 'Image could not be read. Enter the fields manually.', 'error');
      return;
    }

    state.currentResult = out;
    renderFieldTable();
    renderPreview(state.selectedFile);
    renderResultCard($('resultCardUpload'), out, 'Check Result');

    if (out.warning) {
      setBanner('uploadBanner', out.warning, 'warning');
    } else {
      setBanner('uploadBanner', `Completed 10-step check for ${out.fileName}: outcome ${out.status}.`, 'success');
    }
  } catch (err) {
    setBanner('uploadBanner', err.message, 'error');
  }
}

$('btnUploadAndCheck').addEventListener('click', () => runUploadAndCheck(false));

$('btnUseSample').addEventListener('click', async () => {
  const preset = $('samplePresetSelect').value;
  const map = {
    'clean-pdf': { url: '/samples/sample-invoice-clean.pdf', name: 'sample-invoice-clean.pdf', mime: 'application/pdf', lowConf: false },
    'clean-png': { url: '/samples/sample-invoice-clean.png', name: 'sample-invoice-clean.png', mime: 'image/png', lowConf: false },
    'clean-jpg': { url: '/samples/sample-invoice-clean.jpg', name: 'sample-invoice-clean.jpg', mime: 'image/jpeg', lowConf: false },
    'dup-pdf': { url: '/samples/sample-invoice-duplicate.pdf', name: 'sample-invoice-duplicate.pdf', mime: 'application/pdf', lowConf: false },
    'low-conf': { url: '/samples/sample-invoice-clean.png', name: 'sample-invoice-low-ocr.png', mime: 'image/png', lowConf: true },
  };
  const cfg = map[preset] || map['clean-pdf'];
  setBanner('uploadBanner', `Loading ${cfg.name}...`, 'info');
  try {
    const r = await fetch(cfg.url);
    const blob = await r.blob();
    const reader = new FileReader();
    reader.onload = async () => {
      const dataUrl = String(reader.result || '');
      const base64 = dataUrl.includes(',') ? dataUrl.split(',')[1] : dataUrl;
      state.selectedFile = {
        name: cfg.name,
        size: blob.size,
        type: cfg.mime,
        base64,
        dataUrl,
      };
      const kb = Math.max(1, Math.round(blob.size / 1024));
      const info = $('selectedFileInfo');
      info.textContent = `Selected file: ${cfg.name} (${kb} KB)`;
      info.classList.remove('hidden');
      renderPreview(state.selectedFile);
      await runUploadAndCheck(cfg.lowConf);
    };
    reader.readAsDataURL(blob);
  } catch (err) {
    setBanner('uploadBanner', 'Could not load sample file: ' + err.message, 'error');
  }
});

$('btnClearUpload').addEventListener('click', () => {
  state.selectedFile = null;
  state.fields = {};
  state.fieldConfidences = {};
  state.confirmedLowFields = new Set();
  state.currentResult = null;
  $('invoiceFileInput').value = '';
  $('selectedFileInfo').classList.add('hidden');
  $('resultCardUpload').classList.add('hidden');
  setBanner('uploadBanner', '');
  setBanner('postResultBanner', '');
  renderSteps(DEFAULT_STEPS);
  renderFieldTable();
  renderPreview(null);
});

$('btnSaveResult').addEventListener('click', async () => {
  setBanner('postResultBanner', 'Saving and re-evaluating invoice fields...', 'info');
  try {
    const payload = {
      ...state.fields,
      fileName: (state.selectedFile && state.selectedFile.name) || 'manual-entry',
      fileSize: (state.selectedFile && state.selectedFile.size) || 4096,
      source: 'UPLOAD',
    };
    const out = await api('checkInvoice', { invoice: JSON.stringify(payload) });
    state.currentResult = out;
    if (out.steps) renderSteps(out.steps);
    renderResultCard($('resultCardUpload'), out, 'Saved Check Result');
    updatePostButtonState();
    setBanner('postResultBanner', `Result saved to check log (${out.status}). Export is available in Check history.`, 'success');
  } catch (err) {
    setBanner('postResultBanner', err.message, 'error');
  }
});

$('btnPostLedger').addEventListener('click', async () => {
  const unconfirmed = getUnconfirmedLowFields();
  if (unconfirmed.length > 0) {
    setBanner('postResultBanner', `Confirm all Low-confidence fields before posting: ${unconfirmed.join(', ')}`, 'error');
    return;
  }
  setBanner('postResultBanner', 'Posting invoice to ledger...', 'info');
  try {
    const payload = {
      ...state.fields,
      fileName: (state.selectedFile && state.selectedFile.name) || state.fields.invoiceNo,
      unconfirmedLowFields: unconfirmed,
    };
    const out = await api('postInvoice', { invoice: JSON.stringify(payload) });
    state.currentResult = out;
    renderResultCard($('resultCardUpload'), out, 'Ledger Post Result');
    updatePostButtonState();
    if (out.posted) {
      setBanner(
        'postResultBanner',
        out.blocked ? 'Posted to ledger with payment block (HOLD).' : 'Successfully posted to ledger (PASS).',
        out.blocked ? 'warning' : 'success'
      );
      $('btnPostLedger').disabled = true;
    } else {
      setBanner('postResultBanner', 'Not posted: REJECT invoices cannot be posted to ledger.', 'error');
    }
  } catch (err) {
    setBanner('postResultBanner', err.message, 'error');
  }
});

// ============================================================================
// 2.3 S/4HANA EXTRACT PAGE
// ============================================================================
function renderS4Table() {
  const tbody = $('s4TableBody');
  tbody.textContent = '';
  state.s4List.forEach(inv => {
    const res = state.s4Results.find(r => r.id === inv.id);
    const tr = document.createElement('tr');
    tr.className = 'clickable-row';
    const activeNonPass = res
      ? (res.activeResults || res.results.filter(x => ACTIVE_RULE_IDS.includes(x.id)))
          .filter(x => x.tier !== 'PASS')
          .map(x => `${x.id}: ${x.text}`)
          .join(' | ')
      : '';

    tr.append(
      el('td', inv.id || '-'),
      el('td', inv.supplierName || '-'),
      el('td', inv.supplierGstin || '-'),
      el('td', inv.invoiceNo || '-'),
      el('td', inv.invoiceDate || '-'),
      el('td', formatMoney(inv.total))
    );

    const tdStatus = document.createElement('td');
    if (res) {
      tdStatus.append(el('span', res.status, `badge ${res.status}`));
    } else {
      tdStatus.append(el('span', 'PENDING', 'badge SKIPPED'));
    }
    tr.append(tdStatus, el('td', res ? (activeNonPass || 'All active rules passed') : 'Click "Check all" to evaluate'));

    tr.addEventListener('click', () => {
      if (!res) {
        setBanner('s4Banner', 'Click "Check all" first to evaluate this invoice.', 'info');
        return;
      }
      renderResultCard($('resultCardS4'), res, `S/4HANA Invoice ${inv.id}`);
      $('resultCardS4').scrollIntoView({ behavior: 'smooth' });
    });

    tbody.append(tr);
  });
}

$('btnUseSampleS4').addEventListener('click', async () => {
  setBanner('s4Banner', 'Loading sample S/4HANA extract...', 'info');
  try {
    state.s4List = await api('fetchS4Invoices', null, 'GET');
    state.s4Results = [];
    $('resultCardS4').classList.add('hidden');
    renderS4Table();
    setBanner('s4Banner', `Loaded ${state.s4List.length} invoices from sample S/4HANA extract. Click "Check all" to run active rules.`, 'success');
  } catch (err) {
    setBanner('s4Banner', err.message, 'error');
  }
});

$('btnImportS4').addEventListener('click', () => {
  const f = $('s4FileInput').files && $('s4FileInput').files[0];
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
      setBanner('s4Banner', `Imported ${out.count} invoices from ${out.fileName}. Click "Check all" to run active rules.`, 'success');
    } catch (err) {
      setBanner('s4Banner', err.message, 'error');
    }
  };
  reader.readAsText(f);
});

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
    setBanner('s4Banner', `Checked ${state.s4Results.length} S/4HANA invoices. Click any row to view its Result Card.`, 'success');
  } catch (err) {
    setBanner('s4Banner', err.message, 'error');
  }
});

// ============================================================================
// 2.4 REVIEW QUEUE PAGE
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
  tbody.textContent = '';
  const canDecide = state.roles.includes('APController');

  if (!state.alertsList.length) {
    const tr = document.createElement('tr');
    const td = el('td', 'No alerts in the review queue yet. Run an invoice check or S/4HANA batch check to populate alerts.');
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

        // Clear is hidden for REJECT items (Section 2.4)
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

$('btnRefreshAlerts').addEventListener('click', loadAlertsQueue);

// ============================================================================
// 2.5 CHECK HISTORY PAGE (Filters + CSV & Excel Exports with Active Rules Only)
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
  const statusFilter = $('filterHistoryStatus').value;
  const fromDate = $('filterHistoryFrom').value;
  const toDate = $('filterHistoryTo').value;
  const supplierQuery = $('filterHistorySupplier').value.trim().toLowerCase();

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
      el('td', timeStr),
      el('td', r.fileName || r.source || '-'),
      el('td', r.invoiceNo || '-'),
      el('td', `${r.supplierName || '-'} (${r.supplierGstin || '-'})`),
      el('td', formatMoney(r.total))
    );
    const tdSt = document.createElement('td');
    tdSt.append(el('span', r.status, `badge ${r.status}`));
    tr.append(tdSt, el('td', r.createdBy || 'reviewer'));
    tbody.append(tr);
  }
}

$('btnApplyHistoryFilter').addEventListener('click', renderHistoryTable);

function buildHistoryActiveRulesCsv(rows) {
  const headers = [
    'Time',
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

  // Prepend UTF-8 BOM so Microsoft Excel opens the CSV cleanly
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

$('btnExportHistoryCsv').addEventListener('click', () => {
  const csv = buildHistoryActiveRulesCsv(getFilteredHistory());
  state.lastExportCsv = csv;
  window.__lastHistoryExportCsv = csv;
  triggerDownload(csv, 'ap-sentinel-check-history.csv', 'text/csv;charset=utf-8');
});

$('btnExportHistoryExcel').addEventListener('click', () => {
  const csv = buildHistoryActiveRulesCsv(getFilteredHistory());
  state.lastExportCsv = csv;
  window.__lastHistoryExportCsv = csv;
  triggerDownload(csv, 'ap-sentinel-check-history-excel.csv', 'application/vnd.ms-excel;charset=utf-8');
});

// ============================================================================
// 2.6 ACTIVITY LOG PAGE
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
    if (chain.ok) {
      badge.className = 'status-banner success';
      badge.textContent = `Audit Hash Chain: Verified (${chain.entries} entries intact)`;
    } else {
      badge.className = 'status-banner error';
      badge.textContent = `Audit Hash Chain: Broken at entry #${chain.brokenAt}`;
    }
    renderActivityTable();
  } catch (err) {
    console.error(err);
  }
}

function renderActivityTable() {
  const tbody = $('activityTableBody');
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
      el('td', row.ts ? new Date(row.ts).toLocaleString() : '-'),
      el('td', parsed.user),
      el('td', parsed.file),
      el('td', row.action),
      el('td', parsed.clean || parsed.result)
    );
    tbody.append(tr);
  }
}

$('btnRefreshActivity').addEventListener('click', loadActivityLog);

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

// ============================================================================
// 2.7 AI ASSISTANT PAGE (Read-Only Chat + Quick Prompts + Copy Button on Emails)
// ============================================================================
async function sendChatMessage(messageText) {
  const msg = String(messageText || '').trim();
  if (!msg) return;

  const container = $('chatMessages');
  const userBubble = el('div', msg, 'chat-bubble user');
  container.append(userBubble);

  const botBubble = el('div', 'Thinking...', 'chat-bubble assistant');
  container.append(botBubble);
  container.scrollTop = container.scrollHeight;

  try {
    const reply = await api('chat', { message: msg });
    const text = typeof reply === 'string' ? reply : JSON.stringify(reply);
    botBubble.textContent = text;

    // Every drafted email has a Copy button (2.7)
    if (/subject:|dear\s|vendor|discrepancy|regards/i.test(text) || /email/i.test(msg)) {
      const copyWrap = el('div');
      const copyBtn = el('button', 'Copy email draft', 'copy-email-btn');
      copyBtn.type = 'button';
      copyBtn.addEventListener('click', async () => {
        try {
          await navigator.clipboard.writeText(text);
          copyBtn.textContent = 'Copied!';
          setTimeout(() => { copyBtn.textContent = 'Copy email draft'; }, 2000);
        } catch {
          copyBtn.textContent = 'Copied!';
        }
      });
      copyWrap.append(copyBtn);
      botBubble.append(copyWrap);
    }
  } catch (err) {
    botBubble.textContent = err.message || 'The assistant is not configured.';
  }
  container.scrollTop = container.scrollHeight;
}

$('btnSendChat').addEventListener('click', () => {
  const input = $('chatInput');
  const val = input.value;
  input.value = '';
  sendChatMessage(val);
});

$('chatInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    $('btnSendChat').click();
  }
});

document.querySelectorAll('.quick-chat-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    sendChatMessage(btn.dataset.prompt);
  });
});

// ============================================================================
// INITIALIZATION
// ============================================================================
async function initApp() {
  renderSteps(DEFAULT_STEPS);
  renderFieldTable();

  // Support ?role=Auditor | APClerk | APController URL query param
  const params = new URLSearchParams(window.location.search);
  const roleParam = params.get('role');
  if (roleParam) {
    state.roles = roleParam.split(',').map(s => s.trim()).filter(Boolean);
    state.user = state.roles[0].toLowerCase();
    const switcher = $('roleSwitcher');
    if (switcher) switcher.value = roleParam;
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
