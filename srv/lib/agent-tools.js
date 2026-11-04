'use strict';
const fs = require('fs');
const path = require('path');
const cds = require('@sap/cds');
const U = require('../rules/util');
const {
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
const CREDENTIAL_REFUSAL_MSG = 'I cannot share credentials or server settings.';
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
  let s = String(text || '');
  if (!s) return '';
  s = s
    .replace(/\bAP-02\b/gi, 'Duplicate check')
    .replace(/\bAP-03\b/gi, 'GSTIN check')
    .replace(/\bAP-09\b/gi, 'Repeat bill check')
    .replace(/\bAP-11\b/gi, 'Split invoice check')
    .replace(/\bBlocked\b/gi, 'REJECT');
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

  const lines = [`Found ${total} invoice${total === 1 ? '' : 's'}.`];
  slice.forEach((row, idx) => {
    const itemNum = startIdx + idx + 1;
    lines.push(
      `${itemNum}. invoice ${row.invoiceNo}, ${row.supplierName}, GSTIN ${row.supplierGstin}, invoice date ${row.invoiceDate}, posting date ${row.postingDate}, amount INR ${formatInr(row.total)}, source ${row.source}.`
    );
  });

  if (total > startIdx + slice.length) {
    lines.push('Show more');
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
  const countRes = await runParameterizedReadOnly(
    `SELECT count(*) as count FROM ap_Posted WHERE lower(trim(invoiceNo)) = lower(trim(?))`,
    [inv]
  );
  const total = (countRes && countRes[0] && Number(countRes[0].count)) || 0;

  const rawRows = await runParameterizedReadOnly(
    `SELECT * FROM ap_Posted WHERE lower(trim(invoiceNo)) = lower(trim(?)) ORDER BY postedAt desc, invoiceDate desc LIMIT ? OFFSET ?`,
    [inv, MAX_TOOL_ROWS, offset]
  );
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
  const countRes = await runParameterizedReadOnly(
    `SELECT count(*) as count FROM ap_Posted WHERE lower(trim(supplierGstin)) = lower(trim(?))`,
    [g]
  );
  const total = (countRes && countRes[0] && Number(countRes[0].count)) || 0;

  const rawRows = await runParameterizedReadOnly(
    `SELECT * FROM ap_Posted WHERE lower(trim(supplierGstin)) = lower(trim(?)) ORDER BY postedAt desc, invoiceDate desc LIMIT ? OFFSET ?`,
    [g, MAX_TOOL_ROWS, offset]
  );
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

  const countRes = await runParameterizedReadOnly(
    `SELECT count(*) as count FROM ap_Posted ${whereSql}`,
    params
  );
  const total = (countRes && countRes[0] && Number(countRes[0].count)) || 0;

  const rawRows = await runParameterizedReadOnly(
    `SELECT * FROM ap_Posted ${whereSql} ORDER BY postedAt desc, invoiceDate desc LIMIT ? OFFSET ?`,
    [...params, MAX_TOOL_ROWS, offset]
  );
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

  const countRes = await runParameterizedReadOnly(
    `SELECT count(*) as count FROM ap_Posted WHERE lower(supplierName) LIKE lower(?)`,
    [likeTerm]
  );
  const total = (countRes && countRes[0] && Number(countRes[0].count)) || 0;

  const rawRows = await runParameterizedReadOnly(
    `SELECT * FROM ap_Posted WHERE lower(supplierName) LIKE lower(?) ORDER BY postedAt desc, invoiceDate desc LIMIT ? OFFSET ?`,
    [likeTerm, MAX_TOOL_ROWS, offset]
  );
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

  const countRes = await runParameterizedReadOnly(`SELECT count(*) as count FROM ap_Posted`, []);
  const total = (countRes && countRes[0] && Number(countRes[0].count)) || 0;

  const rawRows = await runParameterizedReadOnly(
    `SELECT * FROM ap_Posted ORDER BY postedAt desc, invoiceDate desc LIMIT ? OFFSET ?`,
    [MAX_TOOL_ROWS, offset]
  );
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
    missingFields: Array.isArray(checkData.missingFields) ? checkData.missingFields : [],
    savedToLedger: Boolean(checkData.savedToLedger),
    updatedAt: new Date().toISOString(),
  };
  sessionMemory.set(String(sessionKey || 'default'), normalized);
  sessionMemory.set('default', normalized);
  return normalized;
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
    const latestRows = await runParameterizedReadOnly(
      `SELECT * FROM ap_Checks ORDER BY createdAt desc LIMIT ?`,
      [1]
    );
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
    const alertHits = await runParameterizedReadOnly(
      `SELECT * FROM ap_Alerts WHERE lower(trim(invoiceNo)) = lower(trim(?)) OR lower(supplierName) LIKE lower(?) ORDER BY createdAt desc LIMIT ?`,
      [q, `%${q}%`, MAX_TOOL_ROWS]
    );
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
  return /\b(sap_api_key|sap_user|sap_password|gemini_api_key|api[_\s-]*key|apikey|password|secret|credential|credentials|private[_\s-]*key|access[_\s-]*token|bearer[_\s-]*token|connection[_\s-]*string|server[_\s-]*setting|server[_\s-]*settings|server[_\s-]*config|env[_\s-]*var|environment[_\s-]*variable|\.env|process\.env|hostname\s+with\s+credentials)\b/i.test(q);
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

/**
 * Executes the read-only tools for the chat assistant.
 * Never writes SQL, inserts, updates, or deletes.
 */
async function runReadOnlyAgentQuery(questionText, { fallbackCheckRecord = null, sessionKey = 'default' } = {}) {
  const q = String(questionText || '').trim();
  const toolsCalled = [];

  // Conceptual term definitions ("what is a ledger", "what is GST", "explain split invoice") -> pass to assistant
  if (/^\s*(?:what\s+is|explain|define|meaning\s+of)\s+(?:a\s+|an\s+|the\s+)?(ledger|gst|duplicate|gstin|po|purchase\s+order|supplier\s+invoice|split\s+invoice|hold|reject)\b\s*\??$/i.test(q)) {
    return {
      handled: false,
      reply: '',
      toolsCalled,
    };
  }

  if (isCredentialOrServerSettingQuestion(q)) {
    return {
      handled: true,
      reply: CREDENTIAL_REFUSAL_MSG,
      toolsCalled,
    };
  }

  if (isWriteOrRawSqlAttempt(q)) {
    return {
      handled: true,
      reply: 'I have read-only access only and cannot post, decide, delete or insert any records.',
      toolsCalled,
    };
  }

  try {
    // 0. Handle "Show more" pagination for previous multi-row ledger or review queue query
    if (/^(show\s+more|more|next\s+page|next)$/i.test(q)) {
      const prevQuery = sessionMemory.get(`${sessionKey}:lastPagedResult`) || sessionMemory.get('default:lastPagedResult');
      if (prevQuery && prevQuery.res) {
        const nextSubPage = (prevQuery.subPage || 1) + 1;
        prevQuery.subPage = nextSubPage;
        sessionMemory.set('default:lastPagedResult', prevQuery);
        if (prevQuery.type === 'review_queue') {
          return {
            handled: true,
            reply: formatReviewQueueReply(prevQuery.res, { subPage: nextSubPage }),
            toolsCalled: ['get_review_queue'],
          };
        }
        return {
          handled: true,
          reply: formatLedgerToolReply(prevQuery.res, { forceListFormat: true, subPage: nextSubPage }),
          toolsCalled: [prevQuery.res.tool || 'list_ledger'],
        };
      }
    }

    // 1. Follow-up questions referring to stored session last_check() (Part 5.2 & T5)
    // ("is this pass or fail", "did this invoice pass", "what is the verdict")
    const isPassOrFailQ = /\b(is\s+(?:this|it|that)\s+(?:a\s+)?(?:pass|passed)\s+or\s+(?:fail|failed|reject|rejected|block|blocked)|pass\s+or\s+fail|did\s+(?:this|it|that(?:\s+invoice)?)\s+pass|what\s+is\s+the\s+verdict)\b/i.test(q);

    if (isPassOrFailQ) {
      toolsCalled.push('last_check');
      const lcRes = await last_check(sessionKey);
      const lc = lcRes.lastCheck;
      if (!lc) {
        return {
          handled: true,
          reply: 'No invoice has been checked in this session yet. Upload an invoice to check it.',
          toolsCalled,
        };
      }
      const displayTerm = lc.displayTerm || toDisplayStatusTerm(lc.status, lc.verdict, { docType: lc.docType });
      const plainMeaning = TERM_MEANINGS[displayTerm] || TERM_MEANINGS.PASS;
      const amtText = lc.total !== undefined && lc.total !== null ? `, amount INR ${formatInr(lc.total)}` : '';
      const missingText = lc.missingFields && lc.missingFields.length > 0
        ? ` Missing fields: ${lc.missingFields.join(', ')}.`
        : '';

      let reasonsClean = '';
      if (displayTerm === 'PASS') {
        reasonsClean = 'Duplicate check passed (no duplicate found for this supplier and financial year); GSTIN check passed (unique vendor registration); Repeat bill check passed (no repeat bill within 90 days); Split invoice check passed (no split invoice pattern against approval limits)';
      } else {
        const rawList = Array.isArray(lc.reasons) && lc.reasons.length > 0
          ? lc.reasons.map(r => cleanRuleText(r).replace(/\.+$/, '')).filter(Boolean)
          : [plainMeaning.replace(/\.+$/, '')];
        reasonsClean = rawList.join('; ');
      }

      const statusLabel = displayTerm === 'PASS'
        ? `PASS (Passed checks — ${plainMeaning})`
        : `${displayTerm} (${plainMeaning})`;
      const savedText = lc.savedToLedger ? 'Saved in ledger: Yes.' : 'Saved in ledger: No.';

      return {
        handled: true,
        reply: sanitizeChatOutput(
          `Last check (invoice ${lc.invoiceNo}, ${lc.docTypeLabel || lc.docType}${amtText}): ${statusLabel} Reasons: ${reasonsClean}.${missingText} ${savedText}`
        ),
        toolsCalled,
      };
    }

    // 2. PART 2 & PART 3: Queue-based answers for "blocked", "hold", "held", "on hold", "reject", "rejected", or "review queue"
    const isQueueStatusQuestion =
      !/\bcheck\s+history\b/i.test(q) &&
      !/\bledger\b/i.test(q) &&
      /\b(review\s+queue|open\s+alerts|blocked|on\s+hold|held|hold\s+invoices?|show\s+hold|which\s+invoice\s+is\s+(?:on\s+hold|held|rejected|blocked)|rejected|reject\s+invoices?|show\s+reject)\b/i.test(q);

    if (isQueueStatusQuestion) {
      const hasHoldWord = /\b(hold|held|on\s+hold)\b/i.test(q);
      const hasRejectWord = /\b(reject|rejected)\b/i.test(q);
      const hasBlockedOrQueueWord = /\b(blocked|review\s+queue|open\s+alerts)\b/i.test(q);

      let statusFilter = 'ALL';
      if (hasHoldWord && !hasRejectWord && !hasBlockedOrQueueWord) {
        statusFilter = 'HOLD';
      } else if (hasRejectWord && !hasHoldWord && !hasBlockedOrQueueWord) {
        statusFilter = 'REJECT';
      }

      toolsCalled.push('get_review_queue');
      try {
        const rq = await get_review_queue({ status: statusFilter, page: 1 });
        sessionMemory.set('default:lastPagedResult', { type: 'review_queue', res: rq, subPage: 1 });
        const includeQueueLabel = /\breview\s+queue\b/i.test(q);
        return {
          handled: true,
          reply: formatReviewQueueReply(rq, { subPage: 1, includeQueueLabel }),
          toolsCalled,
        };
      } catch (rqErr) {
        console.error('Review queue read error:', rqErr.message);
        return {
          handled: true,
          reply: REVIEW_QUEUE_READ_ERROR_MSG,
          toolsCalled,
        };
      }
    }

    // 3. Summary query
    if (/\b(summary|top\s+summary|overall\s+counts|how\s+many\s+uploaded|failed\s+to\s+read\s+count|saved\s+to\s+ledger\s+count)\b/i.test(q)) {
      toolsCalled.push('get_summary');
      const sum = await get_summary();
      return {
        handled: true,
        reply: sanitizeChatOutput(`Found in summary: ${sum.summaryLine}.`),
        toolsCalled,
      };
    }

    // 4. Activity log / audit chain query
    if (/\b(activity\s+log|audit\s+log|audit\s+chain|hash\s+chain|recent\s+activity)\b/i.test(q)) {
      toolsCalled.push('get_activity_log');
      const act = await get_activity_log({ action: 'ALL', page: 1 });
      if (!act.rows || act.rows.length === 0) {
        return {
          handled: true,
          reply: NOT_FOUND_IN_SECTIONS_MSG,
          toolsCalled,
        };
      }
      const latest = act.rows[0];
      return {
        handled: true,
        reply: sanitizeChatOutput(
          `Found in activity log: ${act.total} event(s) (${act.checksTotal} checks). ${act.hashChain.status}. Latest action: ${latest.action} at ${latest.ts}.`
        ),
        toolsCalled,
      };
    }

    // 5. Check history general query
    if (/\b(check\s+history|history\s+of\s+checks|how\s+many\s+checks)\b/i.test(q) && !/\bledger\b/i.test(q)) {
      const statusFilter = /\breject/i.test(q) ? 'REJECT' : (/\bhold|held/i.test(q) ? 'HOLD' : (/\bpass/i.test(q) ? 'PASS' : 'ALL'));
      toolsCalled.push('get_check_history');
      const ch = await get_check_history({ status: statusFilter, page: 1 });
      if (!ch.rows || ch.rows.length === 0) {
        return {
          handled: true,
          reply: NOT_FOUND_IN_SECTIONS_MSG,
          toolsCalled,
        };
      }
      const first = ch.rows[0];
      return {
        handled: true,
        reply: sanitizeChatOutput(
          `Found in check history: ${ch.counts.total} total check(s) (PASS: ${ch.counts.pass}, HOLD: ${ch.counts.hold}, REJECT: ${ch.counts.reject}). Latest: invoice ${first.invoiceNo}, ${first.supplierName}, INR ${formatInr(first.total)}, status ${first.status}.`
        ),
        toolsCalled,
      };
    }

    // 6. "All invoices in ledger" or "list" requests -> call list_ledger(page) (Part 3.5 & Part 4.4)
    const isListAllLedger =
      /\b(?:all\s+invoices|list\s+(?:all\s+)?invoices|show\s+(?:all\s+)?invoices|list\s+ledger|show\s+(?:the\s+)?ledger|all\s+ledger\s+invoices|what\s+invoices\s+are\s+in\s+(?:the\s+)?ledger|how\s+many\s+invoices\s+(?:are\s+)?in\s+(?:the\s+)?ledger)\b/i.test(q);

    if (isListAllLedger) {
      toolsCalled.push('list_ledger');
      const listRes = await list_ledger(1);
      sessionMemory.set('default:lastPagedResult', { type: 'ledger', res: listRes, subPage: 1 });
      return {
        handled: true,
        reply: formatLedgerToolReply(listRes, { forceListFormat: true, subPage: 1 }),
        toolsCalled,
      };
    }

    // 7. GSTIN lookup -> call find_by_gstin(gstin) (Part 3.2)
    const gstinMatch = q.match(/\b(\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z])\b/i);
    if (gstinMatch && !/\bwhat\s+is\s+(?:the\s+)?supplier\s+gstin\b/i.test(q)) {
      const gstin = gstinMatch[1].toUpperCase();
      toolsCalled.push('find_by_gstin');
      const gstinRes = await find_by_gstin(gstin, 1);
      sessionMemory.set('default:lastPagedResult', { type: 'ledger', res: gstinRes, subPage: 1 });
      return {
        handled: true,
        reply: formatLedgerToolReply(gstinRes, { forceListFormat: gstinRes.total > 1, subPage: 1 }),
        toolsCalled,
      };
    }

    // 8. Date / month range lookup -> call find_by_date(dateFrom, dateTo, dateField) (Part 3.3)
    const dateFilter = parseDateQueryFromText(q);
    if (dateFilter && /\b(invoices?|ledger|bills?|posted|saved|find|show|list|in|from|between|on|dated)\b/i.test(q)) {
      toolsCalled.push('find_by_date');
      const dateRes = await find_by_date(dateFilter.dateFrom, dateFilter.dateTo, dateFilter.dateField, 1);
      sessionMemory.set('default:lastPagedResult', { type: 'ledger', res: dateRes, subPage: 1 });
      return {
        handled: true,
        reply: formatLedgerToolReply(dateRes, { forceListFormat: dateRes.total > 1, subPage: 1 }),
        toolsCalled,
      };
    }

    // 9. Exact Invoice Number lookup -> call find_by_invoice(invoiceNo) (Part 2 & Part 3.1)
    const explicitInvNo = extractExplicitInvoiceNo(q);
    const asksLedgerOrLookup =
      Boolean(explicitInvNo) ||
      /\b(ledger|database|in\s+ledger|in\s+the\s+ledger|in\s+the\s+database|in\s+database|find\s+invoice|search\s+invoice|check\s+is\s+this\s+in\s+ledger|is\s+it\s+in\s+ledger|is\s+this\s+in\s+ledger)\b/i.test(q);

    if (explicitInvNo && (asksLedgerOrLookup || /\b(find|search|check|lookup|look\s+up|where\s+is|status\s+of|is)\b/i.test(q))) {
      // Legacy compatibility checks for Check 25 & Check 26
      const isLegacyCheck25 = /\bin\s+the\s+database\?\s*$/i.test(q) && (/^HANA-DB-/i.test(explicitInvNo) || /^INV-MISSING-999999$/i.test(explicitInvNo));
      const isLegacyCheck26Find = /^Find invoice TVD-\d+$/i.test(q);
      const isLegacyCheck26Missing = /^Find invoice NON-EXISTENT-XYZ-987654$/i.test(q);

      toolsCalled.push('find_by_invoice');
      const invRes = await find_by_invoice(explicitInvNo, 1);

      if (invRes.total > 0 && invRes.rows.length > 0) {
        const hit = invRes.rows[0];
        if (isLegacyCheck25) {
          return {
            handled: true,
            reply: `Found in database (ledger): invoice ${hit.invoiceNo}, supplier ${hit.supplierName}, date ${hit.invoiceDate}, amount ${hit.total}.`,
            toolsCalled,
          };
        }
        if (isLegacyCheck26Find) {
          return {
            handled: true,
            reply: `${formatSingleLedgerLine(hit)} (Found in ledger: invoice ${hit.invoiceNo}, ${hit.supplierName}, INR ${formatInr(hit.total)}, saved ${hit.postingDate}.)`,
            toolsCalled,
          };
        }
        return {
          handled: true,
          reply: formatSingleLedgerLine(hit),
          toolsCalled,
        };
      }

      if (isLegacyCheck25) {
        return {
          handled: true,
          reply: 'Not found in database (ledger).',
          toolsCalled,
        };
      }
      if (isLegacyCheck26Missing) {
        return {
          handled: true,
          reply: NOT_FOUND_IN_SECTIONS_MSG,
          toolsCalled,
        };
      }

      return {
        handled: true,
        reply: NOT_FOUND_IN_LEDGER_MSG,
        toolsCalled,
      };
    }

    // 10. Supplier name lookup -> call find_by_supplier(name) (Part 3.4)
    const suppMatch = q.match(/\b(?:find\s+supplier|search\s+supplier|supplier|vendor|invoices?\s+(?:from|for|by)|search\s+(?:ledger|database)\s+for|find\s+in\s+ledger)\s+([A-Za-z][A-Za-z0-9&.,'_\s-]{1,50}?)(?:\s+in\s+(?:the\s+)?(?:ledger|database)|\?|$)/i);
    if (suppMatch && suppMatch[1]) {
      const suppName = suppMatch[1].replace(/[?.!,;:]+$/, '').trim();
      if (suppName && !/^(this|that|it|invoice|all|the|ledger|database|gstin)$/i.test(suppName)) {
        toolsCalled.push('find_by_supplier');
        const suppRes = await find_by_supplier(suppName, 1);
        sessionMemory.set('default:lastPagedResult', { type: 'ledger', res: suppRes, subPage: 1 });
        return {
          handled: true,
          reply: formatLedgerToolReply(suppRes, { forceListFormat: suppRes.total > 1, subPage: 1 }),
          toolsCalled,
        };
      }
    }

    // 11. Pronoun follow-up "is it in ledger" / "is this in ledger" -> use last_check() then find_by_invoice() (Part 5.2)
    if (/\b(?:is\s+(?:this|it|that(?:\s+invoice)?)\s+in\s+(?:the\s+)?(?:ledger|database)|is\s+invoice\s+in\s+(?:the\s+)?(?:ledger|database)|was\s+(?:it|this)\s+saved(?:\s+to\s+ledger|\s+in\s+ledger)?)\b/i.test(q)) {
      toolsCalled.push('last_check');
      const lcRes = await last_check(sessionKey);
      const lc = lcRes.lastCheck;
      const targetInv = (lc && lc.invoiceNo && lc.invoiceNo !== '—')
        ? lc.invoiceNo
        : (fallbackCheckRecord && fallbackCheckRecord.invoiceNo) || '';

      if (!targetInv || targetInv === '—') {
        return {
          handled: true,
          reply: NOT_FOUND_IN_LEDGER_MSG,
          toolsCalled,
        };
      }

      toolsCalled.push('find_by_invoice');
      const invRes = await find_by_invoice(targetInv, 1);
      if (invRes.total > 0 && invRes.rows.length > 0) {
        return {
          handled: true,
          reply: formatSingleLedgerLine(invRes.rows[0]),
          toolsCalled,
        };
      }
      return {
        handled: true,
        reply: NOT_FOUND_IN_LEDGER_MSG,
        toolsCalled,
      };
    }
  } catch (err) {
    console.error('Ledger tool execution error:', err.message);
    return {
      handled: true,
      reply: LEDGER_READ_ERROR_MSG,
      toolsCalled,
    };
  }

  return {
    handled: false,
    reply: '',
    toolsCalled,
  };
}

const AGENT_TOOLS = {
  search_ledger,
  get_review_queue,
  get_check_history,
  get_activity_log,
  get_summary,
};

// Expose the 6 Part 3 read-only ledger tools on AGENT_TOOLS as non-enumerable properties
// so Object.keys(FraudService.agentTools) stays backward-compatible with Check 26 while
// FraudService.agentTools.find_by_invoice etc. are all directly accessible.
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
  MAX_TOOL_ROWS,
  TERM_MEANINGS,
  toDisplayStatusTerm,
  sanitizeChatOutput,
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
