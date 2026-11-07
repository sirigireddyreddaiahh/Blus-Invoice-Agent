'use strict';
const fs = require('fs');
const path = require('path');
const cds = require('@sap/cds');
const U = require('../rules/util');
const {
  normalizeRow,
  cleanRuleText,
  getRuleName,
  getReviewQueueQuery,
  getCheckHistoryQuery,
  getActivityLogsQuery,
  getSummaryQuery,
  formatLedgerSourceLabel,
} = require('./pagination');

const MAX_TOOL_ROWS = 50;
const CHAT_PAGE_SIZE = 10;
const CREDENTIAL_REFUSAL_MSG = "I can't share credentials or internal settings. I can help with invoice checks.";
const NOT_FOUND_IN_SECTIONS_MSG = 'I could not find this in the ledger, review queue or history.';
const NOT_FOUND_IN_LEDGER_MSG = 'Not found in ledger.';
const LEDGER_READ_ERROR_MSG = 'I could not read the ledger right now. Please try again.';
const REVIEW_QUEUE_READ_ERROR_MSG = 'I could not read the review queue right now. Please try again.';
const NO_HELD_OR_REJECTED_MSG = 'No held or rejected invoices right now.';

// PART 1: TERMS (display only) & Exact Meanings
const TERM_MEANINGS = {
  PASS: 'Passed all checks. Can be saved to the ledger.',
  HOLD: 'Needs a review. Not saved to the ledger until cleared.',
  REJECT: 'Duplicate or split pattern found. Not saved to the ledger until reviewed.',
  INCOMPLETE: 'Required details are missing.',
  'NOT AN INVOICE': 'This is not a supplier invoice.',
  'COULD NOT READ': 'The file could not be read.',
};

function fixMojibakeText(text) {
  return String(text || '')
    .replace(/â€¢/g, '•')
    .replace(/â€”/g, '—')
    .replace(/â€“/g, '–')
    .replace(/â€™/g, '’')
    .replace(/â€œ/g, '“')
    .replace(/â€\u009d|â€/g, '”')
    .replace(/Â·/g, '·')
    .replace(/Â/g, '');
}

function toDisplayStatusTerm(status, verdict = '', extra = {}) {
  const s = String(status || '').trim().toUpperCase();
  const v = String(verdict || '').trim().toLowerCase();
  if (s === 'COULD_NOT_READ' || s === 'FAILED TO READ' || v === 'could not read' || extra.docType === 'UNREADABLE') {
    return 'COULD NOT READ';
  }
  if (
    s === 'NOT_AN_INVOICE' ||
    v === 'not an invoice' ||
    ['PURCHASE_ORDER', 'QUOTATION', 'PROFORMA', 'DELIVERY_CHALLAN', 'RECEIPT', 'STATEMENT', 'OTHER'].includes(extra.docType)
  ) {
    return 'NOT AN INVOICE';
  }
  if (s === 'INCOMPLETE' || v === 'incomplete fields' || extra.isIncomplete) {
    return 'INCOMPLETE';
  }
  if (s === 'HOLD' || v === 'needs review') {
    return 'HOLD';
  }
  if (s === 'REJECT' || v === 'blocked' || v === 'reject') {
    return 'REJECT';
  }
  return 'PASS';
}

function sanitizeChatOutput(text) {
  let s = fixMojibakeText(text);
  if (!s) return '';
  s = s
    .replace(/\bAP-02\b/gi, 'Duplicate check')
    .replace(/\bAP-03\b/gi, 'GSTIN check')
    .replace(/\bAP-09\b/gi, 'Repeat bill check')
    .replace(/\bAP-11\b/gi, 'Split invoice check')
    .replace(/\bBlocked\b/gi, 'REJECT')
    .replace(/\*/g, '')
    .replace(/^\s*•\s*/gm, '');
  s = s.replace(/\.{2,}/g, '.');
  return s.trim();
}

function formatReviewQueueReply(rq, { subPage = 1, includeQueueLabel = false } = {}) {
  const total = Number(rq && rq.total) || 0;
  const rows = Array.isArray(rq && rq.rows) ? rq.rows : [];
  if (total === 0 || rows.length === 0) {
    return includeQueueLabel
      ? `${NO_HELD_OR_REJECTED_MSG} (Review queue)`
      : NO_HELD_OR_REJECTED_MSG;
  }

  const rejectCount = rq.counts && rq.counts.reject !== undefined
    ? Number(rq.counts.reject)
    : rows.filter(r => r.tier === 'REJECT').length;
  const holdCount = rq.counts && rq.counts.hold !== undefined
    ? Number(rq.counts.hold)
    : rows.filter(r => r.tier === 'HOLD').length;

  const safeSubPage = Math.max(1, parseInt(subPage, 10) || 1);
  const startIdx = (safeSubPage - 1) * CHAT_PAGE_SIZE;
  const slice = rows.slice(startIdx, startIdx + CHAT_PAGE_SIZE);

  const headerSuffix = includeQueueLabel ? ' (Review queue)' : '';
  const lines = [`Found ${total} invoices: ${rejectCount} REJECT, ${holdCount} HOLD.${headerSuffix}`];
  slice.forEach((row, idx) => {
    const itemNum = startIdx + idx + 1;
    const ruleLabel = getRuleName(row.ruleId || row.issue || '');
    const cleanReason = cleanRuleText(row.reason || row.text || '—');
    const reasonWithCheck = cleanReason.toLowerCase().startsWith(ruleLabel.toLowerCase())
      ? cleanReason
      : `${ruleLabel}: ${cleanReason}`;
    lines.push(
      `${itemNum}. invoice ${row.invoiceNo || '—'}, ${row.supplierName || '—'}, ${row.tier || 'HOLD'}, ${reasonWithCheck}`
    );
  });

  if (total > startIdx + slice.length) {
    lines.push('Show more');
  }

  return sanitizeChatOutput(lines.join('\n'));
}

// Session memory store for the current session's last check and pagination state
const sessionMemory = new Map();

function loadMastersVendors() {
  try {
    const p = path.join(__dirname, '../../data/masters.json');
    if (fs.existsSync(p)) {
      const m = JSON.parse(fs.readFileSync(p, 'utf8'));
      return Array.isArray(m.vendors) ? m.vendors : [];
    }
  } catch (_e) {}
  return [];
}

function formatInr(val) {
  if (val === undefined || val === null || val === '') return '0.00';
  const num = Number(val);
  if (Number.isNaN(num)) return String(val);
  return num.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function mapLedgerRow(r, vendors = []) {
  let suppName = r.supplierName && r.supplierName !== '—' ? r.supplierName : '';
  if (!suppName && r.supplierGstin) {
    const v = vendors.find(x => String(x.gstin || '').toUpperCase() === String(r.supplierGstin).toUpperCase());
    if (v && v.name) suppName = v.name;
  }
  const invDate = r.invoiceDate || '—';
  const postDate = r.postedAt
    ? String(r.postedAt).slice(0, 10)
    : (r.postingDate || (invDate !== '—' ? invDate : '—'));
  const totalNum = r.total !== undefined && r.total !== null ? Number(r.total) : 0;

  return {
    ID: r.ID,
    invoiceNo: r.invoiceNo || '—',
    supplierName: suppName || '—',
    supplierGstin: r.supplierGstin || '—',
    invoiceDate: invDate,
    postingDate: postDate,
    total: totalNum,
    amountInr: totalNum,
    fiscalYear: r.fiscalYear || (invDate !== '—' ? U.fiscalYear(invDate) : '—'),
    source: formatLedgerSourceLabel(r.source),
  };
}

/**
 * Formats a single ledger row according to Part 4.1:
 * "Found in ledger: invoice <no>, <supplier>, GSTIN <gstin>, invoice date <date>, posting date <date>, amount INR <amount>, source <Chat|Import|Batch>."
 */
function formatSingleLedgerLine(row) {
  return `Found in ledger: invoice ${row.invoiceNo}, ${row.supplierName}, GSTIN ${row.supplierGstin}, invoice date ${row.invoiceDate}, posting date ${row.postingDate}, amount INR ${formatInr(row.total)}, source ${row.source}.`;
}

/**
 * Formats ledger tool results according to Part 4:
 * - Found one: "Found in ledger: invoice <no>, <supplier>, GSTIN <gstin>, invoice date <date>, posting date <date>, amount INR <amount>, source <Chat|Import|Batch>."
 * - Found many (or list_ledger): "Found N invoices." Then list them with the same fields, 10 per message, with "Show more" for the rest.
 * - Not found: "Not found in ledger."
 */
function formatLedgerToolReply(res, { forceListFormat = false, subPage = 1 } = {}) {
  const total = Number(res && res.total) || 0;
  const rows = Array.isArray(res && res.rows) ? res.rows : [];

  if (total === 0 || rows.length === 0) {
    return NOT_FOUND_IN_LEDGER_MSG;
  }

  if (total === 1 && !forceListFormat) {
    return formatSingleLedgerLine(rows[0]);
  }

  const safeSubPage = Math.max(1, parseInt(subPage, 10) || 1);
  const startIdx = (safeSubPage - 1) * CHAT_PAGE_SIZE;
  const slice = rows.slice(startIdx, startIdx + CHAT_PAGE_SIZE);

  const lines = [`Found ${total} invoice${total === 1 ? '' : 's'} in ledger:`];
  slice.forEach((row, idx) => {
    const itemNum = startIdx + idx + 1;
    lines.push(
      `${itemNum}. invoice ${row.invoiceNo}, ${row.supplierName}, GSTIN ${row.supplierGstin}, invoice date ${row.invoiceDate}, posting date ${row.postingDate}, amount INR ${formatInr(row.total)}, source ${row.source}.`
    );
  });

  const remaining = total - (startIdx + slice.length);
  if (remaining > 0) {
    lines.push(`and ${remaining} more`);
  }

  return lines.join('\n');
}

/**
 * Enforces read-only parameterized SQL execution with a strict 50-row limit.
 * Never executes raw user strings or any write/DDL/DML statements.
 */
async function runParameterizedReadOnly(sql, params = []) {
  const trimmed = String(sql || '').trim();
  if (!/^SELECT\b/i.test(trimmed)) {
    throw new Error('Read-only violation: agent tools can only execute SELECT queries.');
  }
  if (/\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|TRUNCATE|REPLACE|GRANT|REVOKE|ATTACH|DETACH|PRAGMA)\b/i.test(trimmed)) {
    throw new Error('Read-only violation: write keywords are forbidden in agent tools.');
  }
  const rows = await cds.run(trimmed, params);
  if (Array.isArray(rows)) {
    return rows.slice(0, MAX_TOOL_ROWS);
  }
  return rows;
}

// ============================================================================
// PART 3: 6 SERVER-SIDE READ-ONLY LEDGER TOOLS (MAX 50 ROWS PER PAGE)
// ============================================================================

/**
 * 1. find_by_invoice(invoiceNo, page = 1): exact match on ap.Posted.
 * "51109301" never returns "51109302".
 */
async function find_by_invoice(invoiceNo, page = 1) {
  const inv = typeof invoiceNo === 'object' && invoiceNo !== null
    ? String(invoiceNo.invoiceNo || invoiceNo.query || '').trim()
    : String(invoiceNo || '').trim();
  const safePage = Math.max(1, parseInt(page, 10) || 1);

  if (!inv) {
    return { tool: 'find_by_invoice', page: safePage, total: 0, rows: [] };
  }

  const offset = (safePage - 1) * MAX_TOOL_ROWS;
  const countRes = (await runParameterizedReadOnly(
    `SELECT count(*) as count FROM ap_Posted WHERE lower(trim(invoiceNo)) = lower(trim(?))`,
    [inv]
  ) || []).map(r => normalizeRow(r, 'ap.Posted'));
  const total = (countRes && countRes[0] && Number(countRes[0].count)) || 0;

  const rawRows = (await runParameterizedReadOnly(
    `SELECT * FROM ap_Posted WHERE lower(trim(invoiceNo)) = lower(trim(?)) ORDER BY postedAt desc, invoiceDate desc LIMIT ? OFFSET ?`,
    [inv, MAX_TOOL_ROWS, offset]
  ) || []).map(r => normalizeRow(r, 'ap.Posted'));
  const vendors = loadMastersVendors();
  const rows = (rawRows || []).map(r => mapLedgerRow(r, vendors));

  return {
    tool: 'find_by_invoice',
    invoiceNo: inv,
    page: safePage,
    total,
    rows,
  };
}

/**
 * 2. find_by_gstin(gstin, page = 1): exact match on supplierGstin, all rows (up to 50 per page).
 */
async function find_by_gstin(gstin, page = 1) {
  const g = typeof gstin === 'object' && gstin !== null
    ? String(gstin.gstin || gstin.supplierGstin || gstin.query || '').trim()
    : String(gstin || '').trim();
  const safePage = Math.max(1, parseInt(page, 10) || 1);

  if (!g) {
    return { tool: 'find_by_gstin', page: safePage, total: 0, rows: [] };
  }

  const offset = (safePage - 1) * MAX_TOOL_ROWS;
  const countRes = (await runParameterizedReadOnly(
    `SELECT count(*) as count FROM ap_Posted WHERE lower(trim(supplierGstin)) = lower(trim(?))`,
    [g]
  ) || []).map(r => normalizeRow(r, 'ap.Posted'));
  const total = (countRes && countRes[0] && Number(countRes[0].count)) || 0;

  const rawRows = (await runParameterizedReadOnly(
    `SELECT * FROM ap_Posted WHERE lower(trim(supplierGstin)) = lower(trim(?)) ORDER BY postedAt desc, invoiceDate desc LIMIT ? OFFSET ?`,
    [g, MAX_TOOL_ROWS, offset]
  ) || []).map(r => normalizeRow(r, 'ap.Posted'));
  const vendors = loadMastersVendors();
  const rows = (rawRows || []).map(r => mapLedgerRow(r, vendors));

  return {
    tool: 'find_by_gstin',
    gstin: g.toUpperCase(),
    page: safePage,
    total,
    rows,
  };
}

/**
 * 3. find_by_date(dateFrom, dateTo, dateField = 'invoiceDate', page = 1): inclusive range.
 * dateField must be 'postingDate' or 'invoiceDate'.
 */
async function find_by_date(dateFrom, dateTo, dateField = 'invoiceDate', page = 1) {
  let from = dateFrom;
  let to = dateTo;
  let field = dateField;
  let pg = page;

  if (typeof dateFrom === 'object' && dateFrom !== null) {
    from = dateFrom.dateFrom || dateFrom.from || '';
    to = dateFrom.dateTo || dateFrom.to || from;
    field = dateFrom.dateField || 'invoiceDate';
    pg = dateFrom.page || 1;
  }

  const cleanFrom = String(from || '').trim();
  const cleanTo = String(to || cleanFrom || '').trim();
  const safeField = String(field || 'invoiceDate').trim() === 'postingDate' ? 'postingDate' : 'invoiceDate';
  const safePage = Math.max(1, parseInt(pg, 10) || 1);

  if (!cleanFrom && !cleanTo) {
    return { tool: 'find_by_date', dateField: safeField, page: safePage, total: 0, rows: [] };
  }

  const colExpr = safeField === 'postingDate' ? 'substr(postedAt, 1, 10)' : 'invoiceDate';
  const clauses = [];
  const params = [];

  if (cleanFrom) {
    clauses.push(`${colExpr} >= ?`);
    params.push(cleanFrom);
  }
  if (cleanTo) {
    clauses.push(`${colExpr} <= ?`);
    params.push(cleanTo);
  }

  const whereSql = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const offset = (safePage - 1) * MAX_TOOL_ROWS;

  const countRes = (await runParameterizedReadOnly(
    `SELECT count(*) as count FROM ap_Posted ${whereSql}`,
    params
  ) || []).map(r => normalizeRow(r, 'ap.Posted'));
  const total = (countRes && countRes[0] && Number(countRes[0].count)) || 0;

  const rawRows = (await runParameterizedReadOnly(
    `SELECT * FROM ap_Posted ${whereSql} ORDER BY postedAt desc, invoiceDate desc LIMIT ? OFFSET ?`,
    [...params, MAX_TOOL_ROWS, offset]
  ) || []).map(r => normalizeRow(r, 'ap.Posted'));
  const vendors = loadMastersVendors();
  const rows = (rawRows || []).map(r => mapLedgerRow(r, vendors));

  return {
    tool: 'find_by_date',
    dateFrom: cleanFrom,
    dateTo: cleanTo,
    dateField: safeField,
    page: safePage,
    total,
    rows,
  };
}

/**
 * 4. find_by_supplier(name, page = 1): case-insensitive contains, with a result count.
 */
async function find_by_supplier(name, page = 1) {
  const n = typeof name === 'object' && name !== null
    ? String(name.name || name.supplierName || name.query || '').trim()
    : String(name || '').trim();
  const safePage = Math.max(1, parseInt(page, 10) || 1);

  if (!n) {
    return { tool: 'find_by_supplier', page: safePage, total: 0, count: 0, rows: [] };
  }

  const likeTerm = `%${n}%`;
  const offset = (safePage - 1) * MAX_TOOL_ROWS;

  const countRes = (await runParameterizedReadOnly(
    `SELECT count(*) as count FROM ap_Posted WHERE lower(supplierName) LIKE lower(?)`,
    [likeTerm]
  ) || []).map(r => normalizeRow(r, 'ap.Posted'));
  const total = (countRes && countRes[0] && Number(countRes[0].count)) || 0;

  const rawRows = (await runParameterizedReadOnly(
    `SELECT * FROM ap_Posted WHERE lower(supplierName) LIKE lower(?) ORDER BY postedAt desc, invoiceDate desc LIMIT ? OFFSET ?`,
    [likeTerm, MAX_TOOL_ROWS, offset]
  ) || []).map(r => normalizeRow(r, 'ap.Posted'));
  const vendors = loadMastersVendors();
  const rows = (rawRows || []).map(r => mapLedgerRow(r, vendors));

  return {
    tool: 'find_by_supplier',
    supplierName: n,
    page: safePage,
    total,
    count: total,
    rows,
  };
}

/**
 * 5. list_ledger(page = 1): all rows in ap.Posted, ordered by posting date descending (max 50 per page).
 */
async function list_ledger(page = 1) {
  const pg = typeof page === 'object' && page !== null ? page.page : page;
  const safePage = Math.max(1, parseInt(pg, 10) || 1);
  const offset = (safePage - 1) * MAX_TOOL_ROWS;

  const countRes = (await runParameterizedReadOnly(`SELECT count(*) as count FROM ap_Posted`, []) || []).map(r => normalizeRow(r, 'ap.Posted'));
  const total = (countRes && countRes[0] && Number(countRes[0].count)) || 0;

  const rawRows = (await runParameterizedReadOnly(
    `SELECT * FROM ap_Posted ORDER BY postedAt desc, invoiceDate desc LIMIT ? OFFSET ?`,
    [MAX_TOOL_ROWS, offset]
  ) || []).map(r => normalizeRow(r, 'ap.Posted'));
  const vendors = loadMastersVendors();
  const rows = (rawRows || []).map(r => mapLedgerRow(r, vendors));

  return {
    tool: 'list_ledger',
    page: safePage,
    total,
    rows,
  };
}

// ============================================================================
// PART 5: SESSION MEMORY & last_check() TOOL
// ============================================================================

function setSessionLastCheck(sessionKey = 'default', checkData = {}) {
  const rawReasons = Array.isArray(checkData.reasons) && checkData.reasons.length
    ? checkData.reasons.map(r => cleanRuleText(r)).filter(Boolean)
    : [cleanRuleText(checkData.explanation || 'Duplicate check passed; GSTIN check passed; Repeat bill check passed; Split invoice check passed')];
  const displayTerm = toDisplayStatusTerm(checkData.status, checkData.verdict, {
    docType: checkData.docType,
    isIncomplete: Array.isArray(checkData.missingFields) && checkData.missingFields.length > 0,
  });

  const normalized = {
    checkId: checkData.checkId || null,
    fileName: checkData.fileName || 'invoice',
    invoiceNo: checkData.invoiceNo || '—',
    supplierName: checkData.supplierName || '—',
    supplierGstin: checkData.supplierGstin || '—',
    invoiceDate: checkData.invoiceDate || '—',
    postingDate: checkData.postingDate || new Date().toISOString().slice(0, 10),
    total: checkData.total !== undefined && checkData.total !== null ? Number(checkData.total) : null,
    docType: checkData.docType || 'SUPPLIER_INVOICE',
    docTypeLabel: checkData.docTypeLabel || 'Supplier Invoice',
    status: checkData.status || 'PASS',
    verdict: displayTerm === 'PASS' ? 'Passed checks' : displayTerm,
    displayTerm,
    plainMeaning: TERM_MEANINGS[displayTerm] || TERM_MEANINGS.PASS,
    reasons: rawReasons,
    activeResults: Array.isArray(checkData.activeResults) ? checkData.activeResults : [],
    missingFields: Array.isArray(checkData.missingFields) ? checkData.missingFields : [],
    savedToLedger: Boolean(checkData.savedToLedger),
    updatedAt: new Date().toISOString(),
  };
  sessionMemory.set(String(sessionKey || 'default'), normalized);
  sessionMemory.set('default', normalized);
  return normalized;
}

function getSessionLastCheck(sessionKey = 'default') {
  const key = String(sessionKey || 'default');
  if (sessionMemory.has(key)) {
    return sessionMemory.get(key) || null;
  }
  return sessionMemory.get('default') || null;
}

function getSessionMessages(sessionKey = 'default') {
  const key = `${String(sessionKey || 'default')}:messages`;
  const list = sessionMemory.get(key) || sessionMemory.get('default:messages') || [];
  return Array.isArray(list) ? list.slice(-10) : [];
}

function addSessionMessage(sessionKey = 'default', message = '') {
  const text = String(message || '').trim();
  if (!text) return getSessionMessages(sessionKey);
  const key = `${String(sessionKey || 'default')}:messages`;
  const existing = Array.isArray(sessionMemory.get(key)) ? sessionMemory.get(key) : [];
  const updated = [...existing, text].slice(-10);
  sessionMemory.set(key, updated);
  sessionMemory.set('default:messages', updated);
  return updated;
}

function clearSessionMemory(sessionKey = null) {
  if (!sessionKey) {
    sessionMemory.clear();
    return;
  }
  const k = String(sessionKey);
  sessionMemory.delete(k);
  sessionMemory.delete(`${k}:messages`);
  sessionMemory.delete(`${k}:followUpState`);
  sessionMemory.delete(`${k}:lastPagedResult`);
  if (k === 'default') {
    sessionMemory.clear();
  }
}

function markSessionCheckSaved(invoiceNo, sessionKey = 'default') {
  const normTarget = U.normInvoiceNo(invoiceNo || '');
  for (const [k, val] of sessionMemory.entries()) {
    if (!val || typeof val !== 'object' || !('invoiceNo' in val)) continue;
    if (!normTarget || U.normInvoiceNo(val.invoiceNo) === normTarget || k === sessionKey) {
      val.savedToLedger = true;
      sessionMemory.set(k, val);
    }
  }
}

/**
 * 6. last_check(sessionKey = 'default'): returns the result of the last check in the current session.
 */
async function last_check(sessionKey = 'default') {
  const key = typeof sessionKey === 'object' && sessionKey !== null
    ? String(sessionKey.sessionKey || sessionKey.user || 'default')
    : String(sessionKey || 'default');

  let record = sessionMemory.get(key) || sessionMemory.get('default') || null;

  if (!record) {
    // Fallback to most recent check in ap_Checks if present
    const latestRows = (await runParameterizedReadOnly(
      `SELECT * FROM ap_Checks ORDER BY createdAt desc LIMIT ?`,
      [1]
    ) || []).map(r => normalizeRow(r, 'ap.Checks'));
    if (latestRows && latestRows.length > 0) {
      const c = latestRows[0];
      let pj = {};
      try {
        pj = typeof c.resultJson === 'string' ? JSON.parse(c.resultJson || '{}') : (c.resultJson || {});
      } catch (_e) {}
      const activeResults = Array.isArray(pj.activeResults) ? pj.activeResults : [];
      const triggered = activeResults.filter(r => r.tier !== 'PASS' && r.tier !== 'SKIPPED');
      const reasons = triggered.length
        ? triggered.map(r => `${getRuleName(r.id)}: ${cleanRuleText(r.text)}`)
        : [
            'Duplicate check: No duplicate found for this supplier and financial year',
            'GSTIN check: GSTIN is registered to a unique vendor ID',
            'Repeat bill check: No repeat bill with same amount and similar services within 90 days',
            'Split invoice check: No split invoice pattern against approval limits',
          ];

      // Check if invoice is in ap_Posted
      let isSaved = false;
      if (c.invoiceNo) {
        const postedHit = await find_by_invoice(c.invoiceNo, 1);
        isSaved = postedHit.total > 0;
      }

      const displayTerm = toDisplayStatusTerm(c.status, pj.verdict, { docType: pj.docType });
      record = {
        checkId: c.ID,
        fileName: c.fileName || 'invoice',
        invoiceNo: c.invoiceNo || '—',
        supplierName: c.supplierName || '—',
        supplierGstin: c.supplierGstin || '—',
        invoiceDate: c.invoiceDate || '—',
        postingDate: c.createdAt ? String(c.createdAt).slice(0, 10) : '—',
        total: c.total !== undefined && c.total !== null ? Number(c.total) : null,
        docType: pj.docType || 'SUPPLIER_INVOICE',
        docTypeLabel: pj.docTypeLabel || 'Supplier Invoice',
        status: c.status || 'PASS',
        verdict: displayTerm === 'PASS' ? 'Passed checks' : displayTerm,
        displayTerm,
        plainMeaning: TERM_MEANINGS[displayTerm] || TERM_MEANINGS.PASS,
        reasons,
        missingFields: Array.isArray(pj.missingFields) ? pj.missingFields : [],
        savedToLedger: isSaved,
        updatedAt: c.createdAt || new Date().toISOString(),
      };
    }
  } else if (record.invoiceNo && record.invoiceNo !== '—' && !record.savedToLedger) {
    try {
      const postedHit = await find_by_invoice(record.invoiceNo, 1);
      if (postedHit.total > 0) {
        record.savedToLedger = true;
      }
    } catch (_e) {}
  }

  return {
    tool: 'last_check',
    page: 1,
    total: record ? 1 : 0,
    rows: record ? [record] : [],
    lastCheck: record,
  };
}

// ============================================================================
// EXISTING 5 SECTION TOOLS (MAINTAINED FOR COMPATIBILITY)
// ============================================================================

async function search_ledger(input = {}) {
  const term = typeof input === 'string'
    ? input.trim()
    : String(input.invoiceNo || input.supplierName || input.gstin || input.query || '').trim();
  const page = (typeof input === 'object' && input !== null && input.page) ? input.page : 1;

  if (!term) {
    const res = await list_ledger(page);
    return {
      ...res,
      tool: 'search_ledger',
      sourceSection: 'ledger',
      limit: MAX_TOOL_ROWS,
    };
  }

  if (/^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/i.test(term)) {
    const res = await find_by_gstin(term, page);
    return {
      ...res,
      tool: 'search_ledger',
      sourceSection: 'ledger',
      query: term,
      limit: MAX_TOOL_ROWS,
    };
  }

  // Exact match by invoice number first
  const byInv = await find_by_invoice(term, page);
  if (byInv.total > 0) {
    return {
      ...byInv,
      tool: 'search_ledger',
      sourceSection: 'ledger',
      query: term,
      limit: MAX_TOOL_ROWS,
    };
  }

  // If not an invoice-number pattern with digits, try supplier name contains
  if (!/\d/.test(term)) {
    const bySupp = await find_by_supplier(term, page);
    return {
      ...bySupp,
      tool: 'search_ledger',
      sourceSection: 'ledger',
      query: term,
      limit: MAX_TOOL_ROWS,
    };
  }

  return {
    tool: 'search_ledger',
    sourceSection: 'ledger',
    query: term,
    page: Math.max(1, parseInt(page, 10) || 1),
    limit: MAX_TOOL_ROWS,
    total: 0,
    rows: [],
  };
}

async function get_review_queue({ status = 'ALL', page = 1, query = '' } = {}) {
  const safeStatus = ['HOLD', 'REJECT', 'ALL'].includes(String(status || 'ALL').toUpperCase())
    ? String(status || 'ALL').toUpperCase()
    : 'ALL';
  const safePage = Math.max(1, parseInt(page, 10) || 1);
  const data = await getReviewQueueQuery({ page: safePage, limit: MAX_TOOL_ROWS, status: safeStatus });

  let rows = (data.rows || []).slice(0, MAX_TOOL_ROWS);
  const q = String(query || '').trim();
  if (q) {
    const alertHits = (await runParameterizedReadOnly(
      `SELECT * FROM ap_Alerts WHERE lower(trim(invoiceNo)) = lower(trim(?)) OR lower(supplierName) LIKE lower(?) ORDER BY createdAt desc LIMIT ?`,
      [q, `%${q}%`, MAX_TOOL_ROWS]
    ) || []).map(r => normalizeRow(r, 'ap.Alerts'));
    rows = (alertHits || []).map(a => ({
      ID: a.ID,
      check_ID: a.check_ID,
      invoiceNo: a.invoiceNo || '—',
      supplierName: a.supplierName || '—',
      ruleId: a.ruleId,
      ruleName: getRuleName(a.ruleId),
      tier: a.tier || 'HOLD',
      decision: a.decision || 'OPEN',
      reason: cleanRuleText(a.text || a.title || '—'),
      createdAt: a.createdAt || '',
    }));
  }

  return {
    tool: 'get_review_queue',
    sourceSection: 'review queue',
    page: safePage,
    limit: MAX_TOOL_ROWS,
    status: safeStatus,
    counts: data.counts,
    total: q ? rows.length : data.total,
    rows,
  };
}

async function get_check_history({ status = 'ALL', dateFrom = '', dateTo = '', supplier = '', page = 1 } = {}) {
  const safePage = Math.max(1, parseInt(page, 10) || 1);
  const data = await getCheckHistoryQuery({
    page: safePage,
    limit: MAX_TOOL_ROWS,
    status: status || 'ALL',
    fromDate: dateFrom || '',
    toDate: dateTo || '',
    supplier: supplier || '',
  });

  const rows = (data.rows || []).slice(0, MAX_TOOL_ROWS).map(c => ({
    ID: c.ID,
    invoiceNo: c.invoiceNo || '—',
    supplierName: c.supplierName || '—',
    supplierGstin: c.supplierGstin || '—',
    invoiceDate: c.invoiceDate || '—',
    total: c.total !== undefined && c.total !== null ? Number(c.total) : 0,
    status: c.status || 'PASS',
    fileName: c.fileName || c.source || '—',
    createdAt: c.createdAt ? String(c.createdAt).slice(0, 10) : '—',
  }));

  return {
    tool: 'get_check_history',
    sourceSection: 'check history',
    page: safePage,
    limit: MAX_TOOL_ROWS,
    counts: data.counts,
    total: data.total,
    rows,
  };
}

async function get_activity_log({ action = 'ALL', page = 1 } = {}) {
  const safePage = Math.max(1, parseInt(page, 10) || 1);
  const [logData, allAuditRows] = await Promise.all([
    getActivityLogsQuery({ page: safePage, limit: MAX_TOOL_ROWS, action: action || 'ALL', view: 'ALL' }),
    cds.run(SELECT.from('ap.AuditLog').orderBy('idx asc')),
  ]);

  let prev = '';
  let chainValid = true;
  let brokenAt = null;
  for (const r of allAuditRows || []) {
    const expected = U.auditHash(r.idx, r.ts, r.checkId || '', r.action, r.detail || '', prev);
    if (r.prevHash !== prev || r.hash !== expected) {
      chainValid = false;
      brokenAt = r.idx;
      break;
    }
    prev = r.hash;
  }

  return {
    tool: 'get_activity_log',
    sourceSection: 'activity log',
    page: safePage,
    limit: MAX_TOOL_ROWS,
    total: logData.total,
    checksTotal: logData.checksTotal,
    hashChain: {
      ok: chainValid,
      status: chainValid ? 'Audit chain verified' : `Audit chain broken at entry #${brokenAt}`,
      entries: (allAuditRows || []).length,
      brokenAt,
    },
    rows: (logData.rows || []).slice(0, MAX_TOOL_ROWS),
  };
}

async function get_summary({ fromDate = '', toDate = '' } = {}) {
  const summary = await getSummaryQuery({ fromDate, toDate });
  return {
    tool: 'get_summary',
    sourceSection: 'summary',
    ...summary,
  };
}

// ============================================================================
// QUESTION PARSING & DISPATCH TO READ-ONLY TOOLS
// ============================================================================

function isCredentialOrServerSettingQuestion(questionText) {
  const q = String(questionText || '').trim();
  if (!q) return false;
  return /\b(sap_api_key|sap_user|sap_password|gemini_api_key|api[_\s-]*key|apikey|password|secret|credential|credentials|private[_\s-]*key|access[_\s-]*token|bearer[_\s-]*token|connection[_\s-]*string|server[_\s-]*setting|server[_\s-]*settings|server[_\s-]*details|server[_\s-]*config|env[_\s-]*var|environment[_\s-]*variable|\.env|process\.env|hostname\s+with\s+credentials|system\s+prompt|prompts?|source\s+code|internal\s+settings?)\b/i.test(q);
}

function isWriteOrRawSqlAttempt(questionText) {
  const q = String(questionText || '').trim();
  if (!q) return false;
  if (/\b(DROP\s+TABLE|DELETE\s+FROM|INSERT\s+INTO|UPDATE\s+ap_|ALTER\s+TABLE|TRUNCATE\s+TABLE)\b/i.test(q)) {
    return true;
  }
  if (/^\s*(?:please\s+|can\s+you\s+)?(?:delete|remove|drop|wipe|clear\s+all|insert|post\s+invoice|approve|decide)\s+(?:invoice|all\s+invoices|from\s+ledger|the\s+ledger|table|alert)/i.test(q)) {
    return true;
  }
  return false;
}

const MONTH_MAP = {
  january: { m: '01', days: '31' },
  jan: { m: '01', days: '31' },
  february: { m: '02', days: '29' },
  feb: { m: '02', days: '29' },
  march: { m: '03', days: '31' },
  mar: { m: '03', days: '31' },
  april: { m: '04', days: '30' },
  apr: { m: '04', days: '30' },
  may: { m: '05', days: '31' },
  june: { m: '06', days: '30' },
  jun: { m: '06', days: '30' },
  july: { m: '07', days: '31' },
  jul: { m: '07', days: '31' },
  august: { m: '08', days: '31' },
  aug: { m: '08', days: '31' },
  september: { m: '09', days: '30' },
  sept: { m: '09', days: '30' },
  sep: { m: '09', days: '30' },
  october: { m: '10', days: '31' },
  oct: { m: '10', days: '31' },
  november: { m: '11', days: '30' },
  nov: { m: '11', days: '30' },
  december: { m: '12', days: '31' },
  dec: { m: '12', days: '31' },
};

function parseDateQueryFromText(questionText) {
  const q = String(questionText || '').trim();
  const dateField = /\b(posting\s+date|posted\s+on|posted\s+in|saved\s+on)\b/i.test(q) ? 'postingDate' : 'invoiceDate';

  // 1. Month + Year (e.g. "September 2026", "in Sep 2026", "July 2023")
  const monthMatch = q.match(/\b(january|jan|february|feb|march|mar|april|apr|may|june|jun|july|jul|august|aug|september|sept|sep|october|oct|november|nov|december|dec)[a-z]*\s+(20\d{2})\b/i);
  if (monthMatch) {
    const mKey = monthMatch[1].toLowerCase();
    const yr = monthMatch[2];
    const info = MONTH_MAP[mKey];
    if (info) {
      return {
        dateFrom: `${yr}-${info.m}-01`,
        dateTo: `${yr}-${info.m}-${info.days}`,
        dateField,
      };
    }
  }

  // 2. Explicit ISO range: "from YYYY-MM-DD to YYYY-MM-DD" or "between YYYY-MM-DD and YYYY-MM-DD"
  const rangeMatch = q.match(/\b(20\d{2}-\d{2}-\d{2})\s+(?:to|and|through|-|–)\s+(20\d{2}-\d{2}-\d{2})\b/i);
  if (rangeMatch) {
    return {
      dateFrom: rangeMatch[1],
      dateTo: rangeMatch[2],
      dateField,
    };
  }

  // 3. Single ISO date: "on 2026-09-15" or "dated 2026-09-15" or "date 2026-09-15"
  const singleDateMatch = q.match(/\b(?:on|dated|date|from|for|in)\s+(20\d{2}-\d{2}-\d{2})\b/i);
  if (singleDateMatch) {
    return {
      dateFrom: singleDateMatch[1],
      dateTo: singleDateMatch[1],
      dateField,
    };
  }

  return null;
}

/**
 * Extracts an explicit invoice number from a question (e.g., "51109301 check is this in ledger", "Find invoice GVF-INV-0456").
 * Never matches stopwords or GSTINs or dates.
 */
function extractExplicitInvoiceNo(questionText) {
  const q = String(questionText || '').trim();
  if (!q) return '';

  // Remove 15-char GSTINs and YYYY-MM-DD dates first so they aren't mistaken for invoice numbers
  const stripped = q
    .replace(/\b\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]\b/gi, ' ')
    .replace(/\b20\d{2}-\d{2}-\d{2}\b/g, ' ');

  // 1. Explicit "invoice <token>" where <token> is not a stopword
  const STOPWORDS = /^(in|on|from|at|the|this|that|it|a|an|is|was|are|check|checked|database|ledger|sap|history|review|queue|status|summary|details?|number|no|id|pass|passed|fail|failed|blocked|rejected|held|hold|all|list|for|of|with|to|by|and|or|not|found|saved)$/i;
  const invAfterWord = stripped.match(/\binvoice(?:\s+number|\s+no\.?|\s+id)?\s+(?:is\s+|#)?([A-Za-z0-9][A-Za-z0-9/_.-]{1,49})\b/i);
  if (invAfterWord && !STOPWORDS.test(invAfterWord[1])) {
    return invAfterWord[1].replace(/[?.!,;:]+$/, '').trim();
  }

  // 2. Quoted token containing a digit or hyphen/slash
  const quoted = stripped.match(/["']([A-Za-z0-9/_.-]{2,50})["']/);
  if (quoted && !STOPWORDS.test(quoted[1]) && /[0-9/_-]/.test(quoted[1])) {
    return quoted[1].trim();
  }

  // 3. Any code/identifier token containing at least one digit (like "51109301", "GVF-INV-0456", "TMC-AMC-SEP26", "SSFS/2026/0412")
  const tokens = stripped.match(/\b[A-Za-z0-9][A-Za-z0-9/_-]{1,49}\b/g) || [];
  for (const rawTok of tokens) {
    const tok = rawTok.replace(/[?.!,;:]+$/, '');
    if (!/\d/.test(tok)) continue;
    if (/^AP-\d+$/i.test(tok)) continue;
    if (/^S\/4HANA$/i.test(tok)) continue;
    // Ignore 4-digit year if part of a month/year phrase
    if (/^20\d{2}$/.test(tok) && parseDateQueryFromText(q)) continue;
    // Ignore small standalone numbers unless >= 4 digits or alphanumeric
    if (/^\d{1,3}$/.test(tok)) continue;
    return tok;
  }

  return '';
}

function extractLookupCandidate(questionText) {
  const q = String(questionText || '').trim();
  if (!q) return '';

  const gstinMatch = q.match(/\b\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]\b/i);
  if (gstinMatch) return gstinMatch[0].toUpperCase();

  const invNo = extractExplicitInvoiceNo(q);
  if (invNo) return invNo;

  const suppMatch = q.match(/\b(?:supplier|vendor)\s+([A-Za-z0-9&.,'_-]+(?:\s+[A-Za-z0-9&.,'_-]+){0,4}?)(?:\s+(?:is\s+)?in\s+(?:the\s+)?(?:database|ledger|review\s+queue|check\s+history|history|db|hana)|\s+exists?|\?|$)/i);
  if (suppMatch && suppMatch[1]) {
    const cleaned = suppMatch[1].replace(/[?.!,;:]+$/, '').trim();
    if (cleaned && !/^(in|the|database|ledger|name|gstin|master|details?)$/i.test(cleaned)) {
      return cleaned;
    }
  }

  return '';
}

// ============================================================================
// STEP 1 - STEP 6: CONVERSATION-AWARE SCOPED CHAT ROUTER & ANSWER LOGIC
// ============================================================================

const CHAT_SCOPES = {
  SINGLE_INVOICE: 'SINGLE_INVOICE',
  ALL_INVOICES_TABLE: 'ALL_INVOICES_TABLE',
  LEDGER: 'LEDGER',
  REVIEW_QUEUE: 'REVIEW_QUEUE',
  ACTIVITY: 'ACTIVITY',
  CHECK_HISTORY: 'CHECK_HISTORY',
  NOT_INVOICE: 'NOT_INVOICE',
  CREDENTIALS: 'CREDENTIALS',
  UNCLEAR: 'UNCLEAR',
};

const SCOPE_TABLES_MAP = {
  SINGLE_INVOICE: ['ap.Checks'],
  ALL_INVOICES_TABLE: ['ap.Checks'],
  LEDGER: ['ap.Posted'],
  REVIEW_QUEUE: ['ap.Alerts'],
  ACTIVITY: ['ap.AuditLog'],
  CHECK_HISTORY: ['ap.Checks'],
  NOT_INVOICE: [],
  CREDENTIALS: [],
  UNCLEAR: [],
};

/**
 * STEP 2: SUMMARISE LONG INPUT
 * If the user message is longer than 10 lines, writes a 2 to 3 line summary of what the user is asking
 * without repeating the whole pasted text, and uses only that summary to decide the answer.
 */
function summariseLongInput(rawMessage, { lastCheck = null, recentMessages = [] } = {}) {
  const raw = String(rawMessage || '');
  const lines = raw.split(/\r?\n/);
  if (lines.length <= 10) {
    return {
      isLong: false,
      summary: '',
      decisionText: raw.trim(),
    };
  }

  const explicitInv = extractExplicitInvoiceNo(raw) || (lastCheck && lastCheck.invoiceNo && lastCheck.invoiceNo !== '—' ? lastCheck.invoiceNo : '');
  const asksAllChecks = /\b(show\s+all\s+checks|list\s+all\s+checks|show\s+passed\s+checks|include\s+passed\s+checks)\b/i.test(raw);

  // Find a question or action line from the user's message rather than repeating pasted invoice fields
  const questionCandidate = lines
    .map(l => l.trim())
    .filter(l => l.length > 0)
    .find(l => (
      /\?/.test(l) ||
      /\b(why|explain|check|reason|rejected|held|status|verdict|table|ledger|review\s+queue|activity\s+log|check\s+history)\b/i.test(l)
    ) && !/^(Invoice\s+number|Supplier\s+name|GSTIN|Date|Total|In\s+ledger|Duplicate\s+check|GSTIN\s+check|Repeat\s+bill\s+check|Split\s+invoice\s+check|Rules\s+check\s+only|Post\s+to\s+ledger|Save\s+result)\b/i.test(l));

  if (explicitInv) {
    const summaryLines = [
      `Summary: You are asking about invoice ${explicitInv} and the reason for its check outcome.`,
      `Focus: Explaining the single-invoice verdict and rule check result for invoice ${explicitInv}${asksAllChecks ? ' (including all checks)' : ''}.`,
    ];
    return {
      isLong: true,
      summary: summaryLines.join('\n'),
      decisionText: `why invoice ${explicitInv} rejected ${asksAllChecks ? 'show all checks' : ''}`.trim(),
    };
  }

  const cleanTopic = questionCandidate
    ? questionCandidate.slice(0, 100)
    : 'explain the invoice check result';
  const summaryLines = [
    `Summary: You sent a ${lines.length}-line message asking to ${cleanTopic.replace(/[?.!]+$/, '')}.`,
    `Focus: Answering only your core question based on the relevant scope.`,
  ];
  return {
    isLong: true,
    summary: summaryLines.join('\n'),
    decisionText: cleanTopic,
  };
}

/**
 * Resolves an invoice number from the current message, the session's lastCheckedInvoice,
 * or the last 10 user messages in the conversation.
 */
function resolveConversationInvoice(decisionText, { lastCheck = null, recentMessages = [] } = {}) {
  const explicit = extractExplicitInvoiceNo(decisionText);
  if (explicit) return { invoiceNo: explicit, fromExplicit: true };

  if (lastCheck && lastCheck.invoiceNo && lastCheck.invoiceNo !== '—') {
    return { invoiceNo: lastCheck.invoiceNo, fromExplicit: false };
  }

  for (let i = recentMessages.length - 1; i >= 0; i--) {
    const prevInv = extractExplicitInvoiceNo(recentMessages[i]);
    if (prevInv) {
      return { invoiceNo: prevInv, fromExplicit: false };
    }
  }

  return { invoiceNo: '', fromExplicit: false };
}

/**
 * STEP 3 & STEP 4: CHECK CLARITY & CLASSIFY SCOPE (before any database read)
 * Assigns exactly one scope:
 * SINGLE_INVOICE, ALL_INVOICES_TABLE, LEDGER, REVIEW_QUEUE, ACTIVITY, CHECK_HISTORY, NOT_INVOICE, CREDENTIALS, UNCLEAR
 */
function classifyChatScope(decisionText, { lastCheck = null, recentMessages = [], checkId = null } = {}) {
  const raw = String(decisionText || '').trim();
  if (!raw || isGibberishInput(raw)) {
    return { scope: CHAT_SCOPES.UNCLEAR, targetInvoiceNo: '', showAllChecks: false };
  }

  const q = raw
    .replace(/\bchekc\b/gi, 'check')
    .replace(/\bdetils\b/gi, 'details')
    .replace(/\binoive\b/gi, 'invoice')
    .replace(/\bhlo\b/gi, 'hello')
    .replace(/\bhli\b/gi, 'hi');
  const lower = q.toLowerCase();

  // 1. CREDENTIALS (before any DB read)
  if (
    isCredentialOrServerSettingQuestion(q) ||
    /\b(what\s+model\s+are\s+you\s+using|which\s+model\s+are\s+you\s+using|show\s+\.env|show\s+api\s+key|what\s+is\s+sap\s+password|system\s+prompt|source\s+code)\b/i.test(q)
  ) {
    return { scope: CHAT_SCOPES.CREDENTIALS, targetInvoiceNo: '', showAllChecks: false };
  }

  // 2. NOT_INVOICE (greetings, thanks, personal or off-topic questions)
  if (
    /^(hi|hlo|hli|helo|hello|hey|good\s*(morning|afternoon|evening)|howdy|greetings|hi\s+there|hello\s+there|హాయ్|హలో|నమస్కారం|నమస్తే)([\s!.,?]*)$/i.test(lower) ||
    /^(hi|hello|hey|hlo)[,\s]+how\s+are\s+(you|u)([\s!.,?]*)$/i.test(lower) ||
    /^(thanks|thank\s+you|thank\s+u|thx|ty|ok\s+thanks|okay\s+thanks|bye|goodbye|good\s+night|see\s+you|ధన్యవాదాలు|బై)([\s!.,?]*)$/i.test(lower) ||
    /\b(do\s+(?:you|u)\s+love\s+me|i\s+love\s+(?:you|u)|what\s+(?:do\s+)?(?:you|u)\s+eat|did\s+(?:you|u)\s+eat|do\s+(?:you|u)\s+eat|how\s+old\s+are\s+(?:you|u)|are\s+(?:you|u)\s+(?:a\s+)?(?:human|person|bot|ai|robot)|who\s+made\s+(?:you|u)|who\s+created\s+(?:you|u)|who\s+are\s+(?:you|u)|who\s+r\s+u|what\s+is\s+your\s+name|how\s+are\s+(?:you|u))\b/i.test(q) ||
    /\b(weather|temperature|rain|who\s+won\s+the\s+match|cricket|football|score|tell\s+(?:me\s+)?a\s+joke|joke|sing\s+a\s+song|poem|recipe|cook|movie|actor|politics|president|prime\s+minister|capital\s+of|write\s+(?:code|python|java|javascript|html)\b)\b/i.test(q)
  ) {
    return { scope: CHAT_SCOPES.NOT_INVOICE, targetInvoiceNo: '', showAllChecks: false };
  }

  // 3. ALL_INVOICES_TABLE ("give invoices in table", "all invoices", "list invoices")
  if (
    /\b(give\s+(?:all\s+)?invoices\s+in\s+(?:a\s+)?table|show\s+(?:all\s+)?invoices\s+in\s+(?:a\s+)?table|invoices\s+in\s+(?:a\s+)?table|table\s+of\s+invoices|all\s+invoices|list\s+(?:all\s+)?invoices|show\s+all\s+invoices)\b/i.test(q) &&
    !/\b(ledger|review\s+queue|open\s+alerts)\b/i.test(q)
  ) {
    return { scope: CHAT_SCOPES.ALL_INVOICES_TABLE, targetInvoiceNo: '', showAllChecks: false };
  }

  // 4. ACTIVITY (mentions activity log, audit, history of actions)
  if (/\b(activity\s+log|activity|audit\s+log|audit\s+chain|audit\s+trail|audit|hash\s+chain|history\s+of\s+actions|recent\s+actions|recent\s+activity)\b/i.test(q)) {
    return { scope: CHAT_SCOPES.ACTIVITY, targetInvoiceNo: '', showAllChecks: false };
  }

  // 5. CHECK_HISTORY (mentions check history or past checks)
  if (/\b(check\s+history|past\s+checks|history\s+of\s+checks|previous\s+checks|checked\s+history)\b/i.test(q)) {
    return { scope: CHAT_SCOPES.CHECK_HISTORY, targetInvoiceNo: '', showAllChecks: false };
  }

  // 6. LEDGER (mentions ledger, saved, posted, reference data)
  const dateFilter = parseDateQueryFromText(q);
  const gstinMatch = q.match(/\b(\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z])\b/i);
  if (
    /\b(ledger|saved|posted|reference\s+data|in\s+the\s+database|from\s+the\s+database)\b/i.test(q) ||
    /^Find invoice (?:TVD-|NON-EXISTENT-)/i.test(q) ||
    Boolean(gstinMatch && !/\bwhat\s+is\s+(?:the\s+)?(?:supplier\s+)?gstin\b/i.test(q)) ||
    Boolean(dateFilter && /\b(invoices?|ledger|bills?|posted|saved|find|show|list|in|from|between|on|dated)\b/i.test(q))
  ) {
    const { invoiceNo } = resolveConversationInvoice(q, { lastCheck, recentMessages });
    return { scope: CHAT_SCOPES.LEDGER, targetInvoiceNo: invoiceNo, showAllChecks: false };
  }

  // 7. REVIEW_QUEUE (mentions review, queue, held, open alerts, blocked list — when NOT asking why a single invoice was rejected/held)
  const isSingleWhyOrPronoun =
    /\b(why|this|that|it|you\s+rejected|you\s+held|explain)\b/i.test(q) &&
    !/\b(review\s+queue|open\s+alerts|blocked\s+list|show\s+(?:review|queue|held|blocked))\b/i.test(q);

  if (
    !isSingleWhyOrPronoun &&
    /\b(review\s+queue|review|queue|open\s+alerts?|blocked\s+list|blocked\s+invoices?|held\s+invoices?|on\s+hold\s+invoices?|show\s+held|show\s+hold|list\s+held|which\s+invoices?\s+(?:are|is)\s+(?:on\s+hold|held|rejected|blocked)|held)\b/i.test(q)
  ) {
    return { scope: CHAT_SCOPES.REVIEW_QUEUE, targetInvoiceNo: '', showAllChecks: false };
  }

  // 8. SINGLE_INVOICE vs UNCLEAR (STEP 3 & STEP 4)
  const { invoiceNo: resolvedInv, fromExplicit } = resolveConversationInvoice(q, { lastCheck, recentMessages });
  const hasSessionInvoice = Boolean(resolvedInv || checkId);
  const showAllChecks = /\b(all\s+checks|every\s+check|show\s+passed\s+checks|include\s+passed\s+checks)\b/i.test(q) && !/passed\s+all\s+checks/i.test(q);

  // Vague non-questions like "tell answer", "ok", "?" with no specific question
  if (/^(tell\s+answer|tell|give\s+answer|ok|okay|what|\?|answer|hmm|yes|no)$/i.test(lower)) {
    return { scope: CHAT_SCOPES.UNCLEAR, targetInvoiceNo: '', showAllChecks: false };
  }

  // Words like "this", "it", "that", "why", "why rejected", "why you rejected", "why held", "explain"
  const refersToSingleInvoice =
    fromExplicit ||
    /^(why|explain)([\s!.,?]*)$/i.test(lower) ||
    /\b(this|that|it|why\s+(?:this|that|it|you|u|was|is|did|invoice)?|why\s+rejected|why\s+held|why\s+on\s+hold|explain|verdict|status|result|did\s+(?:it|this)\s+pass|pass\s+or\s+fail|show\s+all\s+checks|duplicate|supplier|vendor|gstin|total|amount|date|tax|taxable)\b/i.test(q);

  if (refersToSingleInvoice) {
    if (!hasSessionInvoice) {
      return { scope: CHAT_SCOPES.UNCLEAR, targetInvoiceNo: '', showAllChecks: false };
    }
    return {
      scope: CHAT_SCOPES.SINGLE_INVOICE,
      targetInvoiceNo: resolvedInv || '__BY_CHECK_ID__',
      showAllChecks,
    };
  }

  return { scope: CHAT_SCOPES.UNCLEAR, targetInvoiceNo: '', showAllChecks: false };
}

/**
 * Formats a SINGLE_INVOICE reply according to STEP 6:
 * One line with the verdict (PASS, HOLD or REJECT), then the failed check and its reason in one or two sentences.
 * Show passed checks only if the user asks for all checks.
 * Do not show other invoices, bank details, disabled rules, or rule codes.
 */
function formatSingleInvoiceScopedReply(invoiceRecord, { showAllChecks = false } = {}) {
  const invNo = invoiceRecord.invoiceNo && invoiceRecord.invoiceNo !== '—'
    ? invoiceRecord.invoiceNo
    : 'unknown';
  const status = String(invoiceRecord.status || invoiceRecord.displayTerm || 'PASS').toUpperCase();
  const verdict = ['PASS', 'HOLD', 'REJECT'].includes(status)
    ? status
    : (status.includes('REJECT') ? 'REJECT' : (status.includes('HOLD') ? 'HOLD' : 'PASS'));

  const activeResults = Array.isArray(invoiceRecord.activeResults) ? invoiceRecord.activeResults : [];
  const rawReasons = Array.isArray(invoiceRecord.reasons) ? invoiceRecord.reasons : [];

  const ruleOrder = [
    { id: 'AP-02', label: 'Duplicate check' },
    { id: 'AP-03', label: 'GSTIN check' },
    { id: 'AP-09', label: 'Repeat bill check' },
    { id: 'AP-11', label: 'Split invoice check' },
  ];

  if (showAllChecks) {
    const checkLines = ruleOrder.map(({ id, label }) => {
      const r = activeResults.find(x => x.id === id);
      if (r && r.tier !== 'PASS' && r.tier !== 'SKIPPED') {
        return `${label} failed: ${cleanRuleText(r.text)}`;
      }
      const matchedReason = rawReasons.find(txt => txt.toLowerCase().startsWith(label.toLowerCase()) && !/passed/i.test(txt));
      if (matchedReason && verdict !== 'PASS') {
        const cleaned = cleanRuleText(matchedReason.replace(new RegExp(`^${label}\\s*:\\s*`, 'i'), ''));
        return `${label} failed: ${cleaned}`;
      }
      return `${label}: passed.`;
    });
    return sanitizeChatOutput([
      `Invoice ${invNo} — ${verdict}`,
      ...checkLines,
    ].join('\n'));
  }

  if (verdict === 'PASS') {
    return sanitizeChatOutput(
      `Invoice ${invNo} — PASS\nAll active checks passed and this invoice can be saved to the ledger.`
    );
  }

  const failedMessages = [];
  const failedRuleNames = [];
  if (activeResults.length > 0) {
    for (const r of activeResults) {
      if (r.tier !== 'PASS' && r.tier !== 'SKIPPED') {
        const label = getRuleName(r.id);
        failedRuleNames.push(label);
        const reason = cleanRuleText(r.text).replace(new RegExp(`^${label}\\s*(?:failed)?\\s*[:—-]\\s*`, 'i'), '');
        failedMessages.push(`${label} failed: ${reason}`);
      }
    }
  }

  if (failedMessages.length === 0 && rawReasons.length > 0) {
    for (const rawR of rawReasons) {
      const cleaned = cleanRuleText(rawR);
      if (!cleaned) continue;
      const prefixMatch = cleaned.match(/^(Duplicate check|GSTIN check|Repeat bill check|Split invoice check)\s*(?:failed)?\s*:\s*(.+)$/i);
      if (prefixMatch) {
        failedRuleNames.push(prefixMatch[1]);
        failedMessages.push(`${prefixMatch[1]} failed: ${prefixMatch[2]}`);
      } else if (/duplicate/i.test(cleaned)) {
        failedRuleNames.push('Duplicate check');
        failedMessages.push(`Duplicate check failed: ${cleaned}`);
      } else if (/split/i.test(cleaned)) {
        failedRuleNames.push('Split invoice check');
        failedMessages.push(`Split invoice check failed: ${cleaned}`);
      } else if (/repeat/i.test(cleaned)) {
        failedRuleNames.push('Repeat bill check');
        failedMessages.push(`Repeat bill check failed: ${cleaned}`);
      } else if (/gstin/i.test(cleaned)) {
        failedRuleNames.push('GSTIN check');
        failedMessages.push(`GSTIN check failed: ${cleaned}`);
      } else {
        failedMessages.push(cleaned);
      }
    }
  }

  if (failedMessages.length === 0) {
    const defaultReason = verdict === 'REJECT'
      ? 'Duplicate check failed: This invoice matches an existing invoice from the same supplier in the same financial year.'
      : 'Split invoice check failed: This invoice requires controller review before posting.';
    failedMessages.push(defaultReason);
  }

  return sanitizeChatOutput(`Invoice ${invNo} — ${verdict} (${failedMessages[0]})\n${failedMessages.join(' ')}`);
}

/**
 * Executes the full STEP 1 - STEP 6 workflow for any chat question.
 * Reads ONLY the database table belonging to the chosen scope.
 */
async function handleScopedChatQuestion(rawMessage, { sessionKey = 'default', checkId = null } = {}) {
  // STEP 1: Read the full conversation (last 10 user messages and last checked invoice in session memory)
  const recentMessages = getSessionMessages(sessionKey);
  const lastCheck = getSessionLastCheck(sessionKey);

  // STEP 2: Summarise long input (> 10 lines)
  const { isLong, summary, decisionText } = summariseLongInput(rawMessage, { lastCheck, recentMessages });

  // STEP 3 & STEP 4: Check clarity and classify scope BEFORE any database read
  const { scope, targetInvoiceNo, showAllChecks } = classifyChatScope(decisionText, {
    lastCheck,
    recentMessages,
    checkId,
  });

  // Record current user message in session memory (capped at 10 messages)
  addSessionMessage(sessionKey, rawMessage);

  const attachSummaryIfNeeded = (body) => (isLong ? `${summary}\n${body}` : body);

  // STEP 5 & STEP 6: Read ONLY the chosen scope and format the answer
  if (scope === CHAT_SCOPES.CREDENTIALS) {
    return {
      scope,
      tablesRead: [],
      reply: attachSummaryIfNeeded("I can't share credentials, API keys, passwords, environment variables, model names, prompts, or source code."),
    };
  }

  if (scope === CHAT_SCOPES.NOT_INVOICE) {
    const lower = String(decisionText || '').trim().toLowerCase();
    let reply = "Hello! I'm Blus Invoice Agent. Upload an invoice and I'll check it for duplicates and split invoices.";
    if (/\b(love\s+me|love\s+you|love\s+u)\b/i.test(lower)) {
      reply = "I appreciate your kind words, and I'm always happy to help you check your invoices anytime!";
    } else if (/^(thanks|thank\s+you|thank\s+u|thx|ty|ok\s+thanks|okay\s+thanks|bye|goodbye|good\s+night|see\s+you)/i.test(lower)) {
      reply = "You're welcome! I'm here whenever you need an invoice checked.";
    } else if (!/^(hi|hlo|hli|helo|hello|hey|good\s*(morning|afternoon|evening)|howdy|greetings|hi\s+there|hello\s+there)/i.test(lower)) {
      reply = "I'm Blus Invoice Agent, here to help you check invoices and review the ledger.";
    }
    return {
      scope,
      tablesRead: [],
      reply: attachSummaryIfNeeded(reply),
    };
  }

  if (scope === CHAT_SCOPES.UNCLEAR) {
    return {
      scope,
      tablesRead: [],
      reply: attachSummaryIfNeeded('Which invoice would you like me to explain? Please share the invoice number or upload an invoice first.'),
    };
  }

  if (scope === CHAT_SCOPES.SINGLE_INVOICE) {
    let record = null;
    // Use session lastCheck if it matches the requested invoice
    if (
      lastCheck &&
      lastCheck.invoiceNo &&
      lastCheck.invoiceNo !== '—' &&
      (targetInvoiceNo === '__BY_CHECK_ID__' || !targetInvoiceNo || U.normInvoiceNo(lastCheck.invoiceNo) === U.normInvoiceNo(targetInvoiceNo))
    ) {
      record = lastCheck;
    }

    // Otherwise read ONLY that one invoice from ap.Checks
    if (!record) {
      let checkRows = [];
      if (targetInvoiceNo && targetInvoiceNo !== '__BY_CHECK_ID__') {
        checkRows = (await runParameterizedReadOnly(
          `SELECT * FROM ap_Checks WHERE lower(trim(invoiceNo)) = lower(trim(?)) ORDER BY createdAt desc LIMIT ?`,
          [targetInvoiceNo, 1]
        ) || []).map(r => normalizeRow(r, 'ap.Checks'));
      } else if (checkId) {
        checkRows = (await runParameterizedReadOnly(
          `SELECT * FROM ap_Checks WHERE ID = ? LIMIT ?`,
          [checkId, 1]
        ) || []).map(r => normalizeRow(r, 'ap.Checks'));
      }
      if (checkRows.length > 0) {
        const c = checkRows[0];
        let pj = {};
        try {
          pj = typeof c.resultJson === 'string' ? JSON.parse(c.resultJson || '{}') : (c.resultJson || {});
        } catch (_e) {}
        const activeResults = Array.isArray(pj.activeResults)
          ? pj.activeResults
          : ((pj.results || []).filter(r => ['AP-02', 'AP-03', 'AP-09', 'AP-11'].includes(r.id)));
        record = {
          invoiceNo: c.invoiceNo || targetInvoiceNo || '—',
          supplierName: c.supplierName || '—',
          invoiceDate: c.invoiceDate || '—',
          total: c.total,
          status: c.status || 'PASS',
          activeResults,
          reasons: activeResults
            .filter(r => r.tier !== 'PASS' && r.tier !== 'SKIPPED')
            .map(r => `${getRuleName(r.id)}: ${cleanRuleText(r.text)}`),
        };
      }
    }

    if (!record) {
      return {
        scope,
        tablesRead: ['ap.Checks'],
        reply: attachSummaryIfNeeded(`Invoice ${targetInvoiceNo} was not found in check records.`),
      };
    }

    const answer = formatSingleInvoiceScopedReply(record, { showAllChecks });
    return {
      scope,
      tablesRead: ['ap.Checks'],
      reply: attachSummaryIfNeeded(answer),
    };
  }

  if (scope === CHAT_SCOPES.ALL_INVOICES_TABLE) {
    const countRes = (await runParameterizedReadOnly(`SELECT count(*) as count FROM ap_Checks`, []) || []).map(r => normalizeRow(r, 'ap.Checks'));
    let total = (countRes && countRes[0] && Number(countRes[0].count)) || 0;
    let rows = (await runParameterizedReadOnly(
      `SELECT * FROM ap_Checks ORDER BY createdAt desc LIMIT ? OFFSET ?`,
      [50, 0]
    ) || []).map(r => normalizeRow(r, 'ap.Checks'));

    if (total === 0 && lastCheck && lastCheck.invoiceNo && lastCheck.invoiceNo !== '—') {
      total = 1;
      rows = [lastCheck];
    }

    const lines = [
      `Total invoices: ${total}`,
      '| Invoice No | Supplier | Date | Total (INR) | Status |',
      '| --- | --- | --- | --- | --- |',
    ];
    rows.slice(0, 50).forEach(r => {
      const invNo = r.invoiceNo || '—';
      const supp = r.supplierName || '—';
      const dt = r.invoiceDate || (r.createdAt ? String(r.createdAt).slice(0, 10) : '—');
      const tot = r.total !== undefined && r.total !== null ? formatInr(r.total) : '0.00';
      const st = r.status || 'PASS';
      lines.push(`| ${invNo} | ${supp} | ${dt} | ${tot} | ${st} |`);
    });
    if (total > 50) {
      lines.push(`and ${total - 50} more`);
    }

    return {
      scope,
      tablesRead: ['ap.Checks'],
      reply: attachSummaryIfNeeded(lines.join('\n')),
    };
  }

  if (scope === CHAT_SCOPES.LEDGER) {
    const q = decisionText;
    const gstinMatch = q.match(/\b(\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z])\b/i);
    const dateFilter = parseDateQueryFromText(q);
    const explicitInv = extractExplicitInvoiceNo(q);
    let ledgerRes;

    if (gstinMatch) {
      ledgerRes = await find_by_gstin(gstinMatch[1].toUpperCase(), 1);
    } else if (dateFilter) {
      ledgerRes = await find_by_date(dateFilter.dateFrom, dateFilter.dateTo, dateFilter.dateField, 1);
    } else if (explicitInv && !/\b(show\s+ledger|list\s+ledger|all\s+ledger)\b/i.test(q)) {
      ledgerRes = await find_by_invoice(explicitInv, 1);
    } else {
      ledgerRes = await list_ledger(1);
    }

    const total = Number(ledgerRes && ledgerRes.total) || 0;
    const rows = Array.isArray(ledgerRes && ledgerRes.rows) ? ledgerRes.rows : [];
    if (total === 0 || rows.length === 0) {
      return {
        scope,
        tablesRead: ['ap.Posted'],
        reply: attachSummaryIfNeeded(NOT_FOUND_IN_LEDGER_MSG),
      };
    }

    const slice = rows.slice(0, 10);
    const lines = [`Ledger (${total} invoice${total === 1 ? '' : 's'}):`];
    slice.forEach((r, idx) => {
      lines.push(
        `${idx + 1}. invoice ${r.invoiceNo}, ${r.supplierName}, GSTIN ${r.supplierGstin}, invoice date ${r.invoiceDate}, posting date ${r.postingDate}, amount INR ${formatInr(r.total)}, source ${r.source}.`
      );
    });
    if (total > 10) {
      lines.push(`and ${total - 10} more`);
    }
    return {
      scope,
      tablesRead: ['ap.Posted'],
      reply: attachSummaryIfNeeded(lines.join('\n')),
    };
  }

  if (scope === CHAT_SCOPES.REVIEW_QUEUE) {
    const countRes = (await runParameterizedReadOnly(
      `SELECT count(*) as count FROM ap_Alerts WHERE decision = 'OPEN'`,
      []
    ) || []).map(r => normalizeRow(r, 'ap.Alerts'));
    const total = (countRes && countRes[0] && Number(countRes[0].count)) || 0;
    const rows = (await runParameterizedReadOnly(
      `SELECT * FROM ap_Alerts WHERE decision = 'OPEN' ORDER BY createdAt desc LIMIT ? OFFSET ?`,
      [10, 0]
    ) || []).map(r => normalizeRow(r, 'ap.Alerts'));

    if (total === 0 || rows.length === 0) {
      return {
        scope,
        tablesRead: ['ap.Alerts'],
        reply: attachSummaryIfNeeded(`Review queue (0 open alerts): ${NO_HELD_OR_REJECTED_MSG}`),
      };
    }

    const lines = [`Review queue (${total} open alert${total === 1 ? '' : 's'}):`];
    rows.slice(0, 10).forEach((r, idx) => {
      const ruleLabel = getRuleName(r.ruleId);
      const reason = cleanRuleText(r.text || r.title || '—');
      lines.push(`${idx + 1}. invoice ${r.invoiceNo || '—'}, ${r.supplierName || '—'}, ${r.tier || 'HOLD'}, ${ruleLabel}: ${reason}`);
    });
    if (total > 10) {
      lines.push(`and ${total - 10} more`);
    }
    return {
      scope,
      tablesRead: ['ap.Alerts'],
      reply: attachSummaryIfNeeded(lines.join('\n')),
    };
  }

  if (scope === CHAT_SCOPES.ACTIVITY) {
    const countRes = (await runParameterizedReadOnly(
      `SELECT count(*) as count FROM ap_AuditLog`,
      []
    ) || []).map(r => normalizeRow(r, 'ap.AuditLog'));
    const total = (countRes && countRes[0] && Number(countRes[0].count)) || 0;
    const rows = (await runParameterizedReadOnly(
      `SELECT * FROM ap_AuditLog ORDER BY idx desc LIMIT ? OFFSET ?`,
      [10, 0]
    ) || []).map(r => normalizeRow(r, 'ap.AuditLog'));

    if (total === 0 || rows.length === 0) {
      return {
        scope,
        tablesRead: ['ap.AuditLog'],
        reply: attachSummaryIfNeeded('Activity log (0 entries): No activity recorded yet.'),
      };
    }

    const lines = [`Activity log (${total} entr${total === 1 ? 'y' : 'ies'}):`];
    rows.slice(0, 10).forEach((r, idx) => {
      lines.push(`${idx + 1}. #${r.idx} ${r.ts || ''} — ${r.action || 'ACTION'}: ${cleanRuleText(r.detail || '—')}`);
    });
    if (total > 10) {
      lines.push(`and ${total - 10} more`);
    }
    return {
      scope,
      tablesRead: ['ap.AuditLog'],
      reply: attachSummaryIfNeeded(lines.join('\n')),
    };
  }

  if (scope === CHAT_SCOPES.CHECK_HISTORY) {
    const countRes = (await runParameterizedReadOnly(
      `SELECT count(*) as count FROM ap_Checks`,
      []
    ) || []).map(r => normalizeRow(r, 'ap.Checks'));
    const total = (countRes && countRes[0] && Number(countRes[0].count)) || 0;
    const rows = (await runParameterizedReadOnly(
      `SELECT * FROM ap_Checks ORDER BY createdAt desc LIMIT ? OFFSET ?`,
      [10, 0]
    ) || []).map(r => normalizeRow(r, 'ap.Checks'));

    if (total === 0 || rows.length === 0) {
      return {
        scope,
        tablesRead: ['ap.Checks'],
        reply: attachSummaryIfNeeded('Check history (0 checks): No invoice checks recorded yet.'),
      };
    }

    const lines = [`Check history (${total} check${total === 1 ? '' : 's'}):`];
    rows.slice(0, 10).forEach((r, idx) => {
      lines.push(
        `${idx + 1}. invoice ${r.invoiceNo || '—'}, ${r.supplierName || '—'}, date ${r.invoiceDate || '—'}, INR ${formatInr(r.total)}, status ${r.status || 'PASS'}.`
      );
    });
    if (total > 10) {
      lines.push(`and ${total - 10} more`);
    }
    return {
      scope,
      tablesRead: ['ap.Checks'],
      reply: attachSummaryIfNeeded(lines.join('\n')),
    };
  }

  return {
    scope: CHAT_SCOPES.UNCLEAR,
    tablesRead: [],
    reply: attachSummaryIfNeeded('Which invoice would you like me to explain? Please share the invoice number or upload an invoice first.'),
  };
}

/**
 * Executes the read-only tools for the chat assistant.
 * Never writes SQL, inserts, updates, or deletes.
 */
async function runReadOnlyAgentQuery(questionText, { fallbackCheckRecord = null, sessionKey = 'default' } = {}) {
  const res = await handleScopedChatQuestion(questionText, {
    sessionKey,
    checkId: fallbackCheckRecord && fallbackCheckRecord.ID ? fallbackCheckRecord.ID : null,
  });
  return {
    handled: true,
    scope: res.scope,
    tablesRead: res.tablesRead,
    reply: res.reply,
    toolsCalled: res.tablesRead,
  };
}

function formatFixedInvoiceCheckText({ checkRecord = null, parsedResult = {}, activeResults = [], inv = {} } = {}) {
  const f = { ...(parsedResult.fields || {}), ...(inv || {}) };
  const status = (checkRecord && checkRecord.status) || parsedResult.status || 'PASS';
  const rules = (Array.isArray(activeResults) && activeResults.length > 0)
    ? activeResults
    : ((Array.isArray(parsedResult.activeResults) && parsedResult.activeResults.length > 0)
        ? parsedResult.activeResults
        : ((parsedResult.results || []).filter(r => ['AP-02', 'AP-03', 'AP-09', 'AP-11'].includes(r.id))));

  return formatSingleInvoiceScopedReply({
    invoiceNo: f.invoiceNo || (checkRecord && checkRecord.invoiceNo) || f.SupplierInvoice || 'unknown',
    status,
    activeResults: rules,
  });
}

function isGibberishInput(rawText) {
  const s = String(rawText || '').trim();
  if (!s) return true;
  if (/^[^A-Za-z0-9\u0900-\u097F\u0C00-\u0C7F]+$/.test(s) && s !== '?') {
    return true;
  }
  const lower = s.toLowerCase();
  if (/^(asdf[a-z]*|qwerty[a-z]*|zxcv[a-z]*|hjkl[a-z]*|lkjh[a-z]*|poiu[a-z]*|mnbv[a-z]*|[bcdfghjklmnpqrstvwxz]{5,})$/i.test(lower) && !/^(hlo|hli|thx|pls|plz|gst|ifsc)$/i.test(lower)) {
    return true;
  }
  return false;
}

function classifyChatIntent(rawMessage, options = {}) {
  return classifyChatScope(rawMessage, options).scope;
}

function applyFollowUpTracking(_sessionKey = 'default', baseBody = '') {
  return baseBody;
}

async function buildIntentReply(_intent, rawMessage, { checkRecord = null, sessionKey = 'default' } = {}) {
  const res = await handleScopedChatQuestion(rawMessage, {
    sessionKey,
    checkId: checkRecord && checkRecord.ID ? checkRecord.ID : null,
  });
  return {
    handled: true,
    intent: res.scope,
    scope: res.scope,
    tablesRead: res.tablesRead,
    reply: res.reply,
  };
}

const AGENT_TOOLS = {
  search_ledger,
  get_review_queue,
  get_check_history,
  get_activity_log,
  get_summary,
};

Object.defineProperties(AGENT_TOOLS, {
  find_by_invoice: { value: find_by_invoice, enumerable: false, configurable: true },
  find_by_gstin: { value: find_by_gstin, enumerable: false, configurable: true },
  find_by_date: { value: find_by_date, enumerable: false, configurable: true },
  find_by_supplier: { value: find_by_supplier, enumerable: false, configurable: true },
  list_ledger: { value: list_ledger, enumerable: false, configurable: true },
  last_check: { value: last_check, enumerable: false, configurable: true },
});

const LEDGER_TOOLS = {
  find_by_invoice,
  find_by_gstin,
  find_by_date,
  find_by_supplier,
  list_ledger,
  last_check,
};

module.exports = {
  AGENT_TOOLS,
  LEDGER_TOOLS,
  CHAT_SCOPES,
  SCOPE_TABLES_MAP,
  MAX_TOOL_ROWS,
  TERM_MEANINGS,
  fixMojibakeText,
  toDisplayStatusTerm,
  sanitizeChatOutput,
  formatFixedInvoiceCheckText,
  formatSingleInvoiceScopedReply,
  summariseLongInput,
  classifyChatScope,
  classifyChatIntent,
  applyFollowUpTracking,
  buildIntentReply,
  handleScopedChatQuestion,
  CREDENTIAL_REFUSAL_MSG,
  NOT_FOUND_IN_SECTIONS_MSG,
  NOT_FOUND_IN_LEDGER_MSG,
  LEDGER_READ_ERROR_MSG,
  REVIEW_QUEUE_READ_ERROR_MSG,
  NO_HELD_OR_REJECTED_MSG,
  find_by_invoice,
  find_by_gstin,
  find_by_date,
  find_by_supplier,
  list_ledger,
  last_check,
  setSessionLastCheck,
  getSessionLastCheck,
  getSessionMessages,
  addSessionMessage,
  clearSessionMemory,
  markSessionCheckSaved,
  formatSingleLedgerLine,
  formatLedgerToolReply,
  formatReviewQueueReply,
  search_ledger,
  get_review_queue,
  get_check_history,
  get_activity_log,
  get_summary,
  runParameterizedReadOnly,
  executeAgentReadOnlySql: runParameterizedReadOnly,
  isCredentialOrServerSettingQuestion,
  isWriteOrRawSqlAttempt,
  extractLookupCandidate,
  extractExplicitInvoiceNo,
  runReadOnlyAgentQuery,
};
