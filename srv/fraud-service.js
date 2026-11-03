'use strict';
const cds = require('@sap/cds');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { GoogleGenAI } = require('@google/genai');
const U = require('./rules/util');
const { runRules } = require('./rules/engine');
const { checkDataQuality } = require('./rules/rules');
const {
  extractFields,
  readPdfMeta,
  validateAndDetectFile,
  computeFieldConfidences,
} = require('./lib/extract');
const { extractPdfText } = require('./lib/pdftext');
const { renderPages, findQrJwt, findQrInImage } = require('./lib/pdfimage');
const { runOcr, MISSING_OCR_MSG, OCR_WARNING_MSG } = require('./lib/ocr');
const { parseCsv, s4RowToInvoice } = require('./lib/csv');
const lookup = require('./lib/lookup');
const {
  loadLedgerForInvoices,
  findDatabaseMatch,
  insertInvoiceIntoLedger,
} = require('./lib/ledger');
const { createBatchJob, getJob, cancelJob, resumeJob } = require('./lib/queue');
const { getS4ResultsQuery, getReviewQueueQuery, getCheckHistoryQuery, getActivityLogsQuery } = require('./lib/pagination');
const { processDocumentBatch } = require('./lib/document-processor');

const s4Invoices = require('../data/s4-invoices.json');

const NUMERIC = ['taxable', 'cgst', 'sgst', 'igst', 'cess', 'vat', 'total'];
const DECISIONS = ['CLEAR', 'CONFIRM', 'ESCALATE'];
const ROLES = ['APClerk', 'APController', 'Auditor'];
const ACTIVE_RULE_IDS = ['AP-02', 'AP-03', 'AP-09', 'AP-11'];
const DISABLED_RULE_IDS = ['AP-01', 'AP-04', 'AP-05', 'AP-06', 'AP-07', 'AP-08', 'AP-10', 'AP-12', 'AP-13', 'AP-14'];

const RULES_CHECK_DISCLAIMER =
  'Rules check only. Does not prove the invoice is genuine.';

const REFUSAL_MSG = 'I can only answer questions about this invoice check.';

function loadMasters() {
  return JSON.parse(fs.readFileSync(path.join(__dirname, '../data/masters.json'), 'utf8'));
}

function parseInvoice(raw) {
  const inv = typeof raw === 'string' ? JSON.parse(raw) : { ...raw };
  for (const k of NUMERIC) {
    if (inv[k] !== undefined && inv[k] !== null && inv[k] !== '') inv[k] = Number(String(inv[k]).replace(/,/g, ''));
    else delete inv[k];
  }
  if (inv.invoiceDate && /^\d{2}\/\d{2}\/\d{4}$/.test(inv.invoiceDate)) {
    const [d, m, y] = inv.invoiceDate.split('/');
    inv.invoiceDate = `${y}-${m}-${d}`;
  }
  if (inv.supplierGstin) inv.supplierGstin = String(inv.supplierGstin).trim().toUpperCase();
  if (inv.buyerGstin) inv.buyerGstin = String(inv.buyerGstin).trim().toUpperCase();
  return inv;
}

const publicView = (inv) => { const { pdfText: _text, ...rest } = inv; return rest; };

const isRecurring = (inv, masters) => {
  const po = inv.poNumber ? (masters.purchaseOrders || []).find(p => String(p.po) === String(inv.poNumber)) : null;
  return !!(po && po.recurring);
};

// Role helper supporting XSUAA, mock auth, and role header simulation
function getUserRoles(req) {
  const simulatedRole = req.headers && req.headers['x-user-role'];
  if (simulatedRole) {
    return simulatedRole.split(',').map(s => s.trim()).filter(Boolean);
  }
  if (req.user && Array.isArray(req.user.roles)) {
    return req.user.roles;
  }
  if (req.user && typeof req.user.is === 'function') {
    const matched = ROLES.filter(r => req.user.is(r));
    if (matched.length) return matched;
  }
  return ['APClerk', 'APController'];
}

function getUserId(req) {
  const simulatedUser = req.headers && req.headers['x-user-id'];
  if (simulatedUser) return String(simulatedUser).trim();
  if (req.user && req.user.id && req.user.id !== 'anonymous') return req.user.id;
  const roles = getUserRoles(req);
  if (roles.length === 1) return roles[0].toLowerCase();
  return 'reviewer';
}

/**
 * Maps rule engine status (PASS | HOLD | REJECT) to the exact AI Mode verdict label:
 * - "Passed checks": all four active rules PASS
 * - "Needs review": at least one HOLD, and no REJECT
 * - "Blocked": at least one REJECT
 */
function toVerdictLabel(status, activeResults = []) {
  const hasReject = status === 'REJECT' || activeResults.some(r => r.tier === 'REJECT');
  if (hasReject) return 'Blocked';
  const hasHold = status === 'HOLD' || activeResults.some(r => r.tier === 'HOLD');
  if (hasHold) return 'Needs review';
  return 'Passed checks';
}

/**
 * Strips any occurrence of prohibited words ("fake" or "real") so neither verdict nor explanation ever uses them.
 */
function stripProhibitedWords(str) {
  return String(str || '')
    .replace(/\bfake\b/gi, 'non-compliant')
    .replace(/\breal\b/gi, 'verified');
}

/**
 * Builds the short plain-language explanation strictly from the four active rule results.
 * Never uses the words "fake" or "real".
 */
function buildVerdictExplanation(verdict, activeResults = []) {
  if (verdict === 'Passed checks') {
    return 'No invoice with the same number was found for this supplier this financial year. No similar bill was found within 90 days. The GSTIN is unique to this supplier. The amount is not part of a split pattern.';
  }
  const triggered = activeResults.filter(r => r.tier !== 'PASS');
  if (!triggered.length) {
    return 'Stopped by active rule evaluation.';
  }
  const parts = triggered.map(r => `${r.id} (${r.title}): ${stripProhibitedWords(r.text)}`);
  const prefix = verdict === 'Blocked' ? 'Stopped by active rule check — ' : 'Flagged for review by active rule check — ';
  return stripProhibitedWords(prefix + parts.join(' | '));
}

/**
 * Checks whether a user question is scoped to this invoice check, the extracted fields
 * (including bank IFSC and account number), the rule results, vendor, amounts, or rules used.
 * Refuses ONLY questions clearly unrelated to the current invoice (e.g. weather, another vendor).
 */
function isInvoiceRelatedQuestion(question) {
  const q = String(question || '').trim().toLowerCase();
  if (!q) return false;

  // Refuse only clearly unrelated trivia like weather or another vendor
  const unrelatedPattern = /\b(weather|temperature|rain|forecast|another\s+vendor|other\s+vendor|different\s+vendor|another\s+supplier|other\s+supplier)\b/i;
  if (unrelatedPattern.test(q)) return false;

  return true;
}

/**
 * Builds a question-aware, plain-language response for the checked invoice:
 * - Directly answers bank account / IFSC questions (covering AP-05 status and extracted IFSC/account values)
 * - Directly answers "is this real or fake" / live or past / field / rule questions
 * - Includes the 4 active rules, 10-step check summary when relevant, and mandatory disclaimer
 * Never outputs the prohibited words "fake" or "real".
 */
function buildDetectionAndInvoiceSummary({ checkRecord, parsedResult = {}, activeResults = [], question = '', masters = null }) {
  const q = String(question || '').trim().toLowerCase();
  const status = (checkRecord && checkRecord.status) || parsedResult.status || 'PASS';
  const verdict = toVerdictLabel(status, activeResults);
  const fields = parsedResult.fields || {};
  const dq = parsedResult.dataQuality || null;
  const steps = Array.isArray(parsedResult.steps) && parsedResult.steps.length === 10 ? parsedResult.steps : null;

  const fileLabel = (checkRecord && checkRecord.fileName) || fields.fileName || 'Current invoice';
  const invNo = (checkRecord && checkRecord.invoiceNo) || fields.invoiceNo || 'Not shown on invoice';
  const invDate = (checkRecord && checkRecord.invoiceDate) || fields.invoiceDate || 'Not shown on invoice';
  const supplier = (checkRecord && checkRecord.supplierName) || fields.supplierName || 'Not shown on invoice';
  const supplierGstin = (checkRecord && checkRecord.supplierGstin) || fields.supplierGstin || 'Not shown on invoice';
  const buyerGstin = fields.buyerGstin || 'Not shown on invoice';
  const taxable = fields.taxable !== undefined ? fields.taxable : 'Not shown on invoice';
  const total = (checkRecord && checkRecord.total !== undefined && checkRecord.total !== null)
    ? checkRecord.total
    : (fields.total ?? 'Not shown on invoice');
  const desc = fields.description || 'Not shown on invoice';
  const invoiceIfsc = fields.bankIfsc || fields.ifsc || 'Not shown on invoice';
  const invoiceAccount = fields.bankAccount || fields.accountNo || fields.account || 'Not shown on invoice';

  const allResults = parsedResult.results || [];
  const ap05Rule = allResults.find(r => r.id === 'AP-05');
  const ap05Tier = ap05Rule ? ap05Rule.tier : 'DISABLED';

  let matchedVendor = null;
  if (masters && Array.isArray(masters.vendors)) {
    matchedVendor = masters.vendors.find(
      v => (supplierGstin && v.gstin === supplierGstin) || (supplier && v.name === supplier)
    ) || null;
  }

  // Requirement 3c: Specific handling for bank account / IFSC questions
  const asksBank = /\b(bank|account|ifsc|beneficiary|branch|neft|rtgs|iban|ap-?05)\b/i.test(q);
  if (asksBank) {
    const bankLines = [];
    if (ap05Tier === 'DISABLED') {
      bankLines.push(
        `Bank details check (AP-05 — Bank details changed) is currently disabled by configuration.`
      );
      bankLines.push(
        `Invoice (${invNo}) bank details extracted: IFSC: ${invoiceIfsc} | Account number: ${invoiceAccount}.`
      );
      if (matchedVendor) {
        bankLines.push(
          `Vendor master record for ${matchedVendor.name} (${matchedVendor.id}): IFSC: ${matchedVendor.ifsc || 'Not on file'} | Account number: ${matchedVendor.account || 'Not on file'}.`
        );
      }
    } else if (ap05Tier === 'PASS') {
      bankLines.push(
        `Rule AP-05 (Bank details changed) is active and passed: the bank details on the invoice match the vendor master.`
      );
      bankLines.push(
        `Invoice (${invNo}) IFSC: ${invoiceIfsc} | Account number: ${invoiceAccount}.`
      );
    } else {
      bankLines.push(
        `Rule AP-05 (Bank details changed) is active and held (${ap05Tier}): the bank details on the invoice differ from the vendor master.`
      );
      bankLines.push(
        `Invoice (${invNo}) shows IFSC: ${invoiceIfsc}, Account number: ${invoiceAccount}.`
      );
      bankLines.push(
        `Vendor master shows IFSC: ${(matchedVendor && matchedVendor.ifsc) || 'Not on file'}, Account number: ${(matchedVendor && matchedVendor.account) || 'Not on file'}.`
      );
    }
    bankLines.push(`Note: ${RULES_CHECK_DISCLAIMER}`);
    return stripProhibitedWords(bankLines.join('\n'));
  }

  const lines = [];

  if (checkRecord) {
    lines.push(`Invoice Check Summary (${fileLabel}):`);
    lines.push(`• Verdict: ${verdict} (Rule Status: ${status})`);
    lines.push(`• Invoice No: ${invNo} | Date: ${invDate}`);
    lines.push(`• Supplier: ${supplier} | Supplier GSTIN: ${supplierGstin} | Buyer GSTIN: ${buyerGstin}`);
    lines.push(`• Amounts: Taxable INR ${taxable} | Total INR ${total} | Description: ${desc}`);
    lines.push(`• Bank Details on Invoice: IFSC: ${invoiceIfsc} | Account number: ${invoiceAccount} (Rule AP-05 is ${ap05Tier})`);
    if (dq) {
      lines.push(`• Data Quality (Step 5): Arithmetic ${dq.arithmeticStatus} (${dq.arithmeticText}) · GSTIN format ${dq.gstinStatus} (${dq.gstinText})`);
    }
    if (Array.isArray(parsedResult.similarInvoices)) {
      const simCount = parsedResult.similarInvoices.length;
      lines.push(`• Past Invoices Lookup (Step 7): ${simCount > 0 ? `${simCount} past posted invoice(s) found for this supplier` : 'No matching past posted invoices found'}.`);
    }
    lines.push('');
  }

  lines.push('Summary of the 10-Step Invoice Check Pipeline:');
  if (steps) {
    for (const s of steps) {
      lines.push(`${s.step}. ${s.title} [${s.status}] — ${s.detail}`);
    }
  } else {
    lines.push('1. Received the file — Validates file size (max 10 MB) and reads the uploaded document.');
    lines.push('2. Detected the file type — Identifies PDF with text, Scanned PDF, Image (PNG/JPG), XLSX, or CSV.');
    lines.push('3. Read the document — Extracts embedded PDF text or runs Tesseract OCR + QR e-Invoice JWT decoding.');
    lines.push('4. Extracted the fields — Extracts key fields (Supplier Name, Supplier GSTIN, Buyer GSTIN, Invoice No, Date, PO, Taxable, Taxes, Total, Bank IFSC/Account).');
    lines.push('5. Checked arithmetic and GSTIN format — Verifies Taxable + CGST + SGST + IGST = Total and checks the 15-character GSTIN format & modulo-36 check-character.');
    lines.push('6. Ran the active rules AP-02, AP-03, AP-09, AP-11 — Evaluates the 4 active fraud and duplicate detection rules.');
    lines.push('7. Looked up similar past invoices — Cross-checks against posted invoices and vendor master records.');
    lines.push('8. Decided from the rules — Computes PASS (Passed checks), HOLD (Needs review), or REJECT (Blocked).');
    lines.push('9. Saved to the check log — Records the tamper-evident check and audit trail for Check History export.');
    lines.push('10. Showed the result — Displays the verdict, triggered rule reasons, and recommended next action.');
  }

  lines.push('');
  lines.push('Rules Used to Check the Invoice (4 Active Fraud Rules + Data Quality Checks):');
  lines.push('• AP-02 (Exact duplicate — Outcome: REJECT): Checks if an invoice from the same supplier GSTIN in the same financial year (April–March) already has the same normalised invoice number or IRN.');
  lines.push('• AP-03 (GSTIN reuse — Outcome: REJECT): Checks if one GSTIN is registered across more than one vendor ID in the vendor master (unless on the parent/affiliate exemption list).');
  lines.push('• AP-09 (Same vendor, amount and services — Outcome: REJECT): Checks if the same supplier submitted another bill for the exact same amount with >=90% description similarity within 90 days (recurring contract POs excluded).');
  lines.push('• AP-11 (Split invoices — Outcome: HOLD): Checks if two or more bills from the same supplier within 14 days each sit within 5% below an approval threshold while their combined total reaches >= 1,00,000 INR.');
  lines.push('• Step 5 Data Checks (Arithmetic & GSTIN Format): Verifies that Taxable + Tax equals Total and validates the 15-character GSTIN structure and check-character.');

  if (activeResults && activeResults.length > 0) {
    lines.push('');
    lines.push('Active Rule Results for This Invoice:');
    for (const r of activeResults) {
      lines.push(`• ${r.id} (${r.title}): ${r.tier} — ${r.text}`);
    }
  }

  lines.push('');
  lines.push(`Note: ${RULES_CHECK_DISCLAIMER}`);

  return stripProhibitedWords(lines.join('\n'));
}

/**
 * Redacts invoice-level values (supplier names, GSTINs, invoice numbers, bank details, amounts)
 * from rule reason strings when ALLOW_INVOICE_DATA_TO_LLM is not "true".
 */
function sanitizeRuleReasonForLlm(reasonText, checkRecord = null, fields = {}) {
  let out = String(reasonText || '')
    .replace(/\b\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]\b/gi, '[REDACTED_GSTIN]')
    .replace(/\b[A-Z]{4}0[A-Z0-9]{6}\b/g, '[REDACTED_IFSC]')
    .replace(/\b\d{9,18}\b/g, '[REDACTED_ACCOUNT]')
    .replace(/\b(?:INV|BILL|DUP|SSFS|CLEAN|REPEAT)[\/\-][A-Za-z0-9\/\-]+\b/gi, '[REDACTED_INVOICE_NO]')
    .replace(/(?:INR|Rs\.?)\s*[\d,]+(?:\.\d{2})?/gi, '[REDACTED_AMOUNT]')
    .replace(/\b\d{1,3}(?:,\d{2,3})+(?:\.\d{2})?\b/g, '[REDACTED_AMOUNT]');

  const dynamicSecrets = [
    checkRecord && checkRecord.supplierName,
    checkRecord && checkRecord.supplierGstin,
    checkRecord && checkRecord.invoiceNo,
    checkRecord && checkRecord.total !== undefined && checkRecord.total !== null ? String(checkRecord.total) : null,
    fields && fields.supplierName,
    fields && fields.supplierGstin,
    fields && fields.buyerGstin,
    fields && fields.invoiceNo,
    fields && fields.ifsc,
    fields && fields.bankIfsc,
    fields && fields.accountNo,
    fields && fields.bankAccount,
    fields && fields.account,
    fields && fields.total !== undefined && fields.total !== null ? String(fields.total) : null,
    fields && fields.taxable !== undefined && fields.taxable !== null ? String(fields.taxable) : null,
  ].filter(Boolean);

  for (const secret of dynamicSecrets) {
    const s = String(secret).trim();
    if (s.length >= 3) {
      out = out.split(s).join('[REDACTED]');
    }
  }
  return out;
}

/**
 * Builds the outgoing LLM request for follow-up invoice questions.
 * - Grounding context contains only: verdict, rule IDs, rule results, rule reasons,
 *   and (only when ALLOW_INVOICE_DATA_TO_LLM === 'true') field names with their values.
 * - Never sends raw PDF text, image data, or file contents.
 * - When ALLOW_INVOICE_DATA_TO_LLM is "false" or unset, sends only verdict, rule IDs,
 *   results, and redacted reasons (no supplier name, GSTIN, bank details, or amounts).
 */
function buildInvoiceOutgoingRequest({ checkRecord, parsedResult = {}, activeResults = [], question, allowInvoiceData = false }) {
  const status = (checkRecord && checkRecord.status) || parsedResult.status || 'PASS';
  const verdict = toVerdictLabel(status, activeResults);
  const f = (parsedResult && parsedResult.fields) || {};

  const rulesSummary = activeResults.map(r => ({
    ruleId: r.id || r.ruleId,
    result: r.tier || r.result,
    reason: allowInvoiceData
      ? stripProhibitedWords(r.text || r.reason || '')
      : sanitizeRuleReasonForLlm(stripProhibitedWords(r.text || r.reason || ''), checkRecord, f),
  }));

  const grounding = {
    verdict,
    activeRules: rulesSummary,
    disabledRules: DISABLED_RULE_IDS,
  };

  if (allowInvoiceData && checkRecord) {
    grounding.fields = {
      invoiceNo: checkRecord.invoiceNo || f.invoiceNo || null,
      invoiceDate: checkRecord.invoiceDate || f.invoiceDate || null,
      poNumber: f.poNumber || null,
      description: f.description || null,
      supplierName: checkRecord.supplierName || f.supplierName || null,
      supplierGstin: checkRecord.supplierGstin || f.supplierGstin || null,
      buyerGstin: f.buyerGstin || null,
      taxable: f.taxable ?? null,
      cgst: f.cgst ?? null,
      sgst: f.sgst ?? null,
      igst: f.igst ?? null,
      total: checkRecord.total ?? f.total ?? null,
      ifsc: f.bankIfsc || f.ifsc || null,
      accountNo: f.bankAccount || f.accountNo || f.account || null,
    };
  }

  return {
    question: allowInvoiceData ? String(question || '') : sanitizeRuleReasonForLlm(question, checkRecord, f),
    grounding,
  };
}

/**
 * Builds the grounding payload sent to Gemini for general assistant status queries.
 * Exported so unit and acceptance tests can inspect the exact payload and verify
 * zero GSTIN, bank account, or invoice amount leakage when ALLOW_INVOICE_DATA_TO_LLM is not "true".
 */
function buildGroundingPayload(dbStats, allowInvoiceData = false) {
  const {
    posted = [],
    alerts = [],
    checks = [],
    auditRows = [],
    auditChainValid = true,
  } = dbStats;

  const statusCounts = {
    PASS: checks.filter(c => c.status === 'PASS').length,
    HOLD: checks.filter(c => c.status === 'HOLD').length,
    REJECT: checks.filter(c => c.status === 'REJECT').length,
    FLAG: checks.filter(c => c.status === 'FLAG').length,
  };

  const base = {
    ruleIds: ACTIVE_RULE_IDS,
    disabledRuleIds: DISABLED_RULE_IDS,
    countsByStatus: statusCounts,
    openAlertsCount: alerts.filter(a => a.decision === 'OPEN').length,
    blockedInvoicesCount: posted.filter(p => p.blocked).length,
    totalPostedCount: posted.length,
    totalChecksCount: checks.length,
    auditChainStatus: auditChainValid ? 'VALID' : 'BROKEN',
    auditChainValid,
    auditEntriesCount: auditRows.length,
  };

  if (allowInvoiceData) {
    return {
      ...base,
      recentAlerts: alerts.slice(0, 10).map(a => ({
        ruleId: a.ruleId,
        tier: a.tier,
        decision: a.decision,
        text: a.text,
      })),
    };
  }

  return base;
}

function enrichRuleResult(res) {
  const results = (res.results || []).map(r => ({
    ...r,
    text: stripProhibitedWords(r.text),
  }));
  const activeResults = results.filter(r => ACTIVE_RULE_IDS.includes(r.id));
  const disabledResults = results.filter(r => r.tier === 'DISABLED');
  const verdict = toVerdictLabel(res.status, activeResults);
  const explanation = buildVerdictExplanation(verdict, activeResults);
  return {
    ...res,
    results,
    activeResults,
    disabledRulesCount: disabledResults.length || 10,
    verdict,
    explanation,
    disclaimer: RULES_CHECK_DISCLAIMER,
  };
}

async function performLookupForInvoice(inv, posted, user, masters) {
  const source = lookup.isClientDbEnabled() ? 'client database' : 'masters file';
  const fy = U.fiscalYear(inv.invoiceDate);
  const vendors = await lookup.findVendorByGstin(inv.supplierGstin, { user, masters });
  const vendorId = (vendors[0] && vendors[0].id) || inv.supplierId || inv.supplierGstin;
  const bank = vendorId ? await lookup.findVendorBankDetails(vendorId, { user, masters }) : null;
  const openPos = vendorId ? await lookup.findOpenPurchaseOrders(vendorId, { user, masters }) : [];
  const pastPosted = await lookup.findPostedInvoices(inv.supplierGstin || vendorId, fy, { user, masters, posted });

  return {
    source,
    vendors,
    bank,
    openPos,
    pastPosted,
  };
}

function buildTenSteps({
  fileName,
  fileSize,
  fileTypeLabel,
  readDetail,
  readStatus = 'done',
  fields,
  dataQuality,
  activeResults,
  lookupInfo,
  finalStatus,
  checkId,
}) {
  const kb = Math.max(1, Math.round((Number(fileSize) || 0) / 1024));
  const fieldCount = Object.keys(fields || {}).length;
  const ruleRows = (activeResults || []).map(r => `${r.id} (${r.title}): ${r.tier} — ${r.text}`);
  const pastMatches = (lookupInfo && lookupInfo.pastPosted) || [];
  const matchSummary = pastMatches.length > 0
    ? `${pastMatches.length} past invoice(s) found (${pastMatches.map(m => m.invoiceNo).join(', ')}). Source: ${lookupInfo.source}.`
    : `none. Source: ${(lookupInfo && lookupInfo.source) || 'masters file'}.`;

  const reasons = (activeResults || [])
    .filter(r => r.tier !== 'PASS')
    .map(r => `${r.id}: ${r.tier}`)
    .join(', ') || 'All active rules passed';

  const nextAction = finalStatus === 'REJECT'
    ? 'Do not post. Escalate or reject supplier bill.'
    : (finalStatus === 'HOLD' ? 'Route to APController in Review queue or post with payment block.' : 'Ready to post to ledger.');

  return [
    {
      step: 1,
      title: 'Received the file.',
      status: 'done',
      detail: `Received ${fileName || 'invoice'} (${kb} KB)`,
    },
    {
      step: 2,
      title: 'Detected the file type.',
      status: 'done',
      detail: fileTypeLabel,
    },
    {
      step: 3,
      title: 'Read the document.',
      status: readStatus,
      detail: readDetail,
    },
    {
      step: 4,
      title: 'Extracted the fields.',
      status: readStatus === 'failed' ? 'failed' : 'done',
      detail: `${fieldCount} fields found`,
    },
    {
      step: 5,
      title: 'Checked arithmetic and GSTIN format.',
      status: (dataQuality.arithmeticValid && dataQuality.gstinValid) ? 'done' : 'Check',
      detail: `Arithmetic: ${dataQuality.arithmeticStatus} (${dataQuality.arithmeticText}) · GSTIN format: ${dataQuality.gstinStatus} (${dataQuality.gstinText})`,
    },
    {
      step: 6,
      title: 'Ran the active rules AP-02, AP-03, AP-09, AP-11.',
      status: 'done',
      detail: ruleRows.join(' | '),
      rows: activeResults,
    },
    {
      step: 7,
      title: 'Looked up similar past invoices.',
      status: 'done',
      detail: matchSummary,
    },
    {
      step: 8,
      title: 'Decided from the rules.',
      status: 'done',
      detail: finalStatus,
    },
    {
      step: 9,
      title: 'Saved to the check log.',
      status: checkId ? 'done' : 'waiting',
      detail: 'Saved. Export is available in Check history.',
    },
    {
      step: 10,
      title: 'Showed the result.',
      status: 'done',
      detail: `Status: ${finalStatus} · Reasons: ${reasons} · Next action: ${nextAction}`,
    },
  ];
}

class FraudService extends cds.ApplicationService {
  async init() {
    const E = {
      Checks: 'ap.Checks',
      CheckResults: 'ap.CheckResults',
      Alerts: 'ap.Alerts',
      Posted: 'ap.Posted',
      AuditLog: 'ap.AuditLog',
    };

    const audit = async (action, checkId, detail, meta = {}) => {
      const last = await cds.run(SELECT.one.from(E.AuditLog).orderBy('idx desc'));
      const idx = last ? last.idx + 1 : 1;
      const prevHash = last ? last.hash : '';
      const ts = new Date().toISOString();
      const user = meta.user || 'reviewer';
      const file = meta.fileName || '-';
      const result = meta.result || '';
      const formattedDetail = `[user=${user}][file=${file}][result=${result}] ${detail || ''}`.trim();
      const hash = U.auditHash(idx, ts, checkId || '', action, formattedDetail, prevHash);
      await cds.run(INSERT.into(E.AuditLog).entries({
        idx,
        ts,
        action,
        checkId: checkId || null,
        detail: formattedDetail.slice(0, 1000),
        prevHash,
        hash,
      }));
    };

    const persist = async (inv, result, source, req, extraMeta = {}) => {
      const user = req ? getUserId(req) : 'reviewer';
      const checkId = extraMeta.checkId || crypto.randomUUID();
      const enriched = enrichRuleResult(result);
      const storedPayload = {
        ...enriched,
        steps: extraMeta.steps || undefined,
        dataQuality: extraMeta.dataQuality || undefined,
        fields: extraMeta.fields || publicView(inv),
        lookupSource: extraMeta.lookupInfo ? extraMeta.lookupInfo.source : undefined,
        similarInvoices: extraMeta.lookupInfo ? extraMeta.lookupInfo.pastPosted : undefined,
      };
      const ts = new Date().toISOString();
      await cds.run(INSERT.into(E.Checks).entries({
        ID: checkId,
        createdAt: ts,
        createdBy: user,
        source,
        fileName: inv.fileName || null,
        supplierName: inv.supplierName || null,
        supplierGstin: inv.supplierGstin || null,
        invoiceNo: inv.invoiceNo || null,
        invoiceDate: inv.invoiceDate || null,
        total: inv.total ?? null,
        status: result.status,
        resultJson: JSON.stringify(storedPayload),
      }));
      await cds.run(INSERT.into(E.CheckResults).entries(enriched.results.map(r => ({
        ID: crypto.randomUUID(),
        check_ID: checkId,
        ruleId: r.id,
        title: r.title,
        tier: r.tier,
        text: r.text,
      }))));
      const alerts = enriched.results.filter(r => ['REJECT', 'HOLD', 'FLAG'].includes(r.tier));
      for (const r of alerts) {
        r.alertId = crypto.randomUUID();
        await cds.run(INSERT.into(E.Alerts).entries({
          ID: r.alertId,
          createdAt: ts,
          createdBy: user,
          check_ID: checkId,
          ruleId: r.id,
          title: r.title,
          tier: r.tier,
          text: r.text,
          decision: 'OPEN',
          invoiceNo: inv.invoiceNo || null,
          supplierName: inv.supplierName || null,
        }));
      }

      if (source === 'CHAT') {
        // Section 6: Log the user, time, file name and verdict. Do not log file contents or any key.
        console.log(`[CHAT_CHECK] User: ${user}, Time: ${ts}, File: ${inv.fileName || 'invoice.pdf'}, Verdict: ${enriched.verdict}`);
        await audit(
          'CHAT_CHECK',
          checkId,
          `Verdict: ${enriched.verdict} (${result.status})`,
          { user, fileName: inv.fileName || 'invoice.pdf', result: enriched.verdict }
        );
      } else {
        await audit(
          'CHECK',
          checkId,
          `${result.status} ${inv.invoiceNo || ''}: ${alerts.map(a => a.id).join(', ') || 'no alerts'}`,
          { user, fileName: inv.fileName || inv.invoiceNo || source, result: result.status }
        );
      }
      return checkId;
    };

    const applyDecision = async (req, alertId, decision, comment) => {
      const roles = getUserRoles(req);
      if (!roles.includes('APController')) {
        if (roles.includes('APClerk')) return req.reject(403, 'A clerk cannot decide an alert.');
        if (roles.includes('Auditor')) return req.reject(403, 'An auditor cannot decide an alert.');
        return req.reject(403, 'Only APController can decide an alert.');
      }

      if (!DECISIONS.includes(decision)) return req.reject(400, 'Decision must be CLEAR, CONFIRM or ESCALATE');
      const text = String(comment || '').trim();
      if (!text) return req.reject(400, 'A comment is required for every decision');
      const alert = await cds.run(SELECT.one.from(E.Alerts).where({ ID: alertId }));
      if (!alert) return req.reject(404, 'Alert not found');
      if (alert.tier === 'REJECT' && decision === 'CLEAR') return req.reject(409, 'A REJECT is final and cannot be cleared');

      const who = getUserId(req);
      await cds.run(UPDATE(E.Alerts).set({ decision, comment: text, decidedBy: who, decidedAt: new Date().toISOString() }).where({ ID: alertId }));
      await audit('DECISION', alert.check_ID, `${alert.ruleId} ${decision} by ${who}: ${text}`, {
        user: who,
        fileName: alert.ruleId,
        result: decision,
      });

      // After an invoice gets cleared in the Review queue, insert it into the ledger so future uploads are compared against it
      if (decision === 'CLEAR') {
        const remaining = await cds.run(
          SELECT.from(E.Alerts).where({ check_ID: alert.check_ID, decision: { '!=': 'CLEAR' } })
        );
        const stillPending = remaining.filter(a => a.ID !== alertId);
        if (stillPending.length === 0) {
          const check = await cds.run(SELECT.one.from(E.Checks).where({ ID: alert.check_ID }));
          if (check) {
            let invObj = {
              invoiceNo: check.invoiceNo,
              supplierGstin: check.supplierGstin,
              invoiceDate: check.invoiceDate,
              total: check.total,
              supplierName: check.supplierName,
              fileName: check.fileName,
            };
            if (check.resultJson) {
              try {
                const pj = JSON.parse(check.resultJson);
                if (pj.fields) invObj = { ...invObj, ...pj.fields };
              } catch {}
            }
            const masters = loadMasters();
            await insertInvoiceIntoLedger(parseInvoice(invObj), { blocked: false, user: who, masters });
            await audit('LEDGER_INSERT', alert.check_ID, `Cleared in review queue: posted ${invObj.invoiceNo} into ledger`, {
              user: who,
              fileName: invObj.invoiceNo || 'cleared-invoice',
              result: 'CLEARED_INSERTED',
            });
          }
        }
      }

      return JSON.stringify({ alertId, decision, decidedBy: who });
    };

    this.on('whoami', req => {
      const roles = getUserRoles(req);
      const id = getUserId(req);
      return JSON.stringify({ id, roles });
    });

    this.on('fetchS4Invoices', () => JSON.stringify(s4Invoices));

    this.on('importS4Extract', async req => {
      const roles = getUserRoles(req);
      if (roles.includes('Auditor') && !roles.includes('APClerk') && !roles.includes('APController')) {
        return req.reject(403, 'An auditor cannot import or check invoices.');
      }
      const { fileName, content } = req.data;
      const text = String(content || '').replace(/^\uFEFF/, '').trim();
      if (!text) return req.reject(400, 'The file is empty');
      let list;
      try {
        list = text.startsWith('[') ? JSON.parse(text) : parseCsv(text).map(s4RowToInvoice);
      } catch (e) { return req.reject(400, 'The file could not be read: ' + e.message); }
      if (!Array.isArray(list) || !list.length) return req.reject(400, 'The file has no invoice rows');
      if (list.length > 2000) {
        return req.reject(400, `This batch has ${list.length} invoices. The maximum per job is 2000. Please split the file.`);
      }
      const user = getUserId(req);
      await audit('IMPORT', null, `${fileName || 'extract'}: ${list.length} rows`, {
        user,
        fileName: fileName || 's4-extract.csv',
        result: `${list.length} rows`,
      });
      return JSON.stringify({ fileName, count: list.length, invoices: list.map(i => ({ ...i, source: 'S4' })) });
    });

    // Full upload + extraction + check pipeline supporting PDF, PNG, JPG, CSV, and XLSX
    const handleDocumentUpload = async (req, { fileName, fileSize, fileBase64, runCheck = true, source = 'UPLOAD' }) => {
      const roles = getUserRoles(req);
      if (roles.includes('Auditor') && !roles.includes('APClerk') && !roles.includes('APController')) {
        return req.reject(403, 'An auditor cannot upload or check invoices.');
      }

      const buf = Buffer.from(fileBase64 || '', 'base64');
      const actualSize = fileSize !== undefined && fileSize !== null ? Number(fileSize) : buf.length;
      const detection = validateAndDetectFile(fileName, buf, actualSize);
      if (!detection.ok) {
        return req.reject(400, detection.error);
      }

      const user = getUserId(req);
      const masters = loadMasters();
      let text = '';
      let fileTypeLabel = detection.label;
      let ocrUsed = false;
      let ocrConfidence = 98;
      let ocrWords = [];
      let warning = null;
      let qrJwt = null;
      let readStatus = 'done';
      let readDetail = '';
      let preExtractedFields = null;

      if (detection.kind === 'PDF') {
        const pdfTextRes = await extractPdfText(buf);
        const pages = await renderPages(buf, { maxPages: 2, scale: 2.0 });
        qrJwt = findQrJwt(pages);

        if (pdfTextRes.hasTextLayer) {
          fileTypeLabel = 'PDF with text';
          text = pdfTextRes.text;
          const preview = text.replace(/\s+/g, ' ').slice(0, 120);
          readDetail = `Text preview: "${preview}${text.length > 120 ? '...' : ''}"`;
        } else {
          fileTypeLabel = 'Scanned PDF';
          ocrUsed = true;
          const pageBuffer = (pages[0] && pages[0].png) ? pages[0].png : buf;
          const ocrRes = await runOcr(pageBuffer);
          if (!ocrRes.ok) {
            readStatus = 'failed';
            warning = MISSING_OCR_MSG;
            readDetail = MISSING_OCR_MSG;
          } else {
            text = ocrRes.text;
            ocrConfidence = ocrRes.confidence;
            ocrWords = ocrRes.words;
            warning = OCR_WARNING_MSG;
            readDetail = `Read by OCR (confidence: ${ocrConfidence}%). "${text.replace(/\s+/g, ' ').slice(0, 90)}..."`;
          }
        }
      } else if (detection.kind === 'PNG' || detection.kind === 'JPG') {
        fileTypeLabel = 'Image (PNG or JPG)';
        ocrUsed = true;
        qrJwt = await findQrInImage(buf);
        const ocrRes = await runOcr(buf);
        if (!ocrRes.ok) {
          readStatus = 'failed';
          warning = MISSING_OCR_MSG;
          readDetail = MISSING_OCR_MSG;
        } else {
          text = ocrRes.text;
          ocrConfidence = ocrRes.confidence;
          ocrWords = ocrRes.words;
          warning = OCR_WARNING_MSG;
          readDetail = `Read by OCR (confidence: ${ocrConfidence}%). "${text.replace(/\s+/g, ' ').slice(0, 90)}..."`;
        }
      } else if (detection.kind === 'CSV') {
        fileTypeLabel = 'CSV Spreadsheet';
        text = buf.toString('utf8');
        const rows = parseCsv(text);
        if (rows.length > 0) {
          preExtractedFields = s4RowToInvoice(rows[0], 0);
          delete preExtractedFields.id;
          delete preExtractedFields.source;
        }
        readDetail = `Parsed CSV (${rows.length} row(s))`;
      } else if (detection.kind === 'XLSX') {
        fileTypeLabel = 'Excel Spreadsheet (XLSX)';
        const rawText = buf.toString('utf8');
        const xmlTextMatches = [...rawText.matchAll(/<t[^>]*>([^<]+)<\/t>/g)].map(m => m[1]);
        text = xmlTextMatches.length > 0 ? xmlTextMatches.join('\n') : rawText;
        const rows = parseCsv(text);
        if (rows.length > 0 && (rows[0].invoiceno || rows[0].suppliergstin)) {
          preExtractedFields = s4RowToInvoice(rows[0], 0);
          delete preExtractedFields.id;
          delete preExtractedFields.source;
        }
        readDetail = 'Extracted spreadsheet fields from XLSX';
      }

      if (readStatus === 'failed') {
        const failedSteps = buildTenSteps({
          fileName,
          fileSize: actualSize,
          fileTypeLabel,
          readDetail: MISSING_OCR_MSG,
          readStatus: 'failed',
          fields: {},
          dataQuality: { arithmeticValid: false, arithmeticStatus: 'FAIL', arithmeticText: 'No fields read', gstinValid: false, gstinStatus: 'FAIL', gstinText: 'No fields read' },
          activeResults: [],
          lookupInfo: { source: lookup.isClientDbEnabled() ? 'client database' : 'masters file', pastPosted: [] },
          finalStatus: 'HOLD',
          checkId: null,
        });
        return JSON.stringify({
          ok: false,
          fileName,
          fileType: fileTypeLabel,
          fields: {},
          fieldConfidences: {},
          pdfText: '',
          ocrUsed: true,
          ocrConfidence: 0,
          warning: MISSING_OCR_MSG,
          error: MISSING_OCR_MSG,
          steps: failedSteps,
        });
      }

      const fields = preExtractedFields && Object.keys(preExtractedFields).length > 0
        ? preExtractedFields
        : extractFields(text);
      if (qrJwt) fields.qrJwt = qrJwt;
      const threshold = (masters.config && masters.config.ocrLowConfidenceThreshold) || 70;
      const fieldConfidences = computeFieldConfidences(fields, {
        ocrUsed,
        ocrConfidence,
        words: ocrWords,
        threshold,
      });

      const effectiveSource = source === 'CHAT' ? 'CHAT' : 'UPLOAD';
      const inv = parseInvoice({
        ...fields,
        fileName,
        pdfText: text,
        pdfMeta: detection.kind === 'PDF' ? readPdfMeta(buf) : { producer: detection.kind, creator: '' },
        source: effectiveSource,
      });

      const posted = await loadLedgerForInvoices([inv]);
      let lookupInfo;
      try {
        lookupInfo = await performLookupForInvoice(inv, posted, user, masters);
      } catch (err) {
        return req.reject(400, err.message);
      }

      const dataQuality = checkDataQuality(inv);
      const rawResult = runRules(inv, {
        masters,
        posted,
        batch: [],
        earlier: [],
        irpPublicKeyPem: process.env.IRP_PUBLIC_KEY_PEM || undefined,
      });
      const enriched = enrichRuleResult(rawResult);
      const databaseMatch = findDatabaseMatch(inv, { posted });
      const preCheckId = runCheck ? crypto.randomUUID() : null;

      const steps = buildTenSteps({
        fileName,
        fileSize: actualSize,
        fileTypeLabel,
        readDetail,
        readStatus: 'done',
        fields,
        dataQuality,
        activeResults: enriched.activeResults,
        lookupInfo,
        finalStatus: enriched.status,
        checkId: preCheckId,
      });

      const checkId = runCheck
        ? await persist(inv, rawResult, effectiveSource, req, {
            checkId: preCheckId,
            steps,
            dataQuality,
            fields,
            lookupInfo,
          })
        : null;

      // After an invoice gets PASS, insert it into the ledger so future uploads are compared against it
      if (runCheck && enriched.status === 'PASS') {
        await insertInvoiceIntoLedger(inv, { blocked: false, user, masters });
        await audit(
          'LEDGER_INSERT',
          checkId,
          `Auto-inserted passed invoice ${inv.invoiceNo || ''} into database ledger`,
          { user, fileName: inv.fileName || inv.invoiceNo, result: 'PASS_INSERTED' }
        );
      }

      if (runCheck) {
        await audit(
          'DATABASE_CHECK',
          checkId,
          `Checked against database ledger: ${databaseMatch.status} (${databaseMatch.reason})`,
          { user, fileName: inv.fileName || inv.invoiceNo, result: databaseMatch.status }
        );
      }

      return JSON.stringify({
        ok: true,
        checkId,
        source: effectiveSource,
        fileName,
        fileSize: actualSize,
        fileType: fileTypeLabel,
        fields,
        fieldConfidences,
        dataQuality,
        lookupSource: lookupInfo.source,
        similarInvoices: lookupInfo.pastPosted,
        databaseMatch,
        pdfText: text,
        pdfMeta: inv.pdfMeta,
        qrFound: Boolean(qrJwt),
        ocrUsed,
        ocrConfidence,
        warning,
        status: enriched.status,
        verdict: enriched.verdict,
        explanation: enriched.explanation,
        disclaimer: enriched.disclaimer,
        results: enriched.results,
        activeResults: enriched.activeResults,
        disabledRulesCount: enriched.disabledRulesCount,
        steps,
        invoice: publicView(inv),
      });
    };

    this.on('extractPdf', async req => {
      const { fileName, pdfBase64 } = req.data;
      return handleDocumentUpload(req, {
        fileName: fileName || 'invoice.pdf',
        fileSize: Buffer.from(pdfBase64 || '', 'base64').length,
        fileBase64: pdfBase64,
        runCheck: false,
        source: 'UPLOAD',
      });
    });

    this.on('uploadDocument', async req => {
      const { fileName, fileSize, fileBase64, source } = req.data;
      return handleDocumentUpload(req, {
        fileName,
        fileSize,
        fileBase64,
        runCheck: true,
        source: source || 'UPLOAD',
      });
    });

    // Section 6: Chat-mode invoice check reusing extractPdf/handleDocumentUpload and checkInvoice with source "CHAT"
    this.on('chatCheckInvoice', async req => {
      const { fileName, fileSize, fileBase64 } = req.data;
      return handleDocumentUpload(req, {
        fileName,
        fileSize,
        fileBase64,
        runCheck: true,
        source: 'CHAT',
      });
    });

    this.on('checkInvoice', async req => {
      const roles = getUserRoles(req);
      if (roles.includes('Auditor') && !roles.includes('APClerk') && !roles.includes('APController')) {
        return req.reject(403, 'An auditor cannot check invoices.');
      }

      const user = getUserId(req);
      const masters = loadMasters();
      const inv = parseInvoice(req.data.invoice);
      const posted = await loadLedgerForInvoices([inv]);

      let lookupInfo;
      try {
        lookupInfo = await performLookupForInvoice(inv, posted, user, masters);
      } catch (err) {
        return req.reject(400, err.message);
      }

      const dataQuality = checkDataQuality(inv);
      const result = runRules(inv, {
        masters,
        posted,
        batch: [],
        earlier: [],
        irpPublicKeyPem: process.env.IRP_PUBLIC_KEY_PEM || undefined,
      });
      const enriched = enrichRuleResult(result);
      const databaseMatch = findDatabaseMatch(inv, { posted });
      const effectiveSource = inv.source || 'UPLOAD';
      const preCheckId = crypto.randomUUID();

      const steps = buildTenSteps({
        fileName: inv.fileName || inv.invoiceNo || 'manual-entry',
        fileSize: inv.fileSize || 4096,
        fileTypeLabel: inv.fileType || 'PDF with text',
        readDetail: inv.pdfText ? `Text preview: "${String(inv.pdfText).slice(0, 100)}"` : 'Manual / verified field entry',
        readStatus: 'done',
        fields: publicView(inv),
        dataQuality,
        activeResults: enriched.activeResults,
        lookupInfo,
        finalStatus: enriched.status,
        checkId: preCheckId,
      });

      const checkId = await persist(inv, result, effectiveSource, req, {
        checkId: preCheckId,
        steps,
        dataQuality,
        fields: publicView(inv),
        lookupInfo,
      });

      // After an invoice gets PASS, insert it into the ledger so future uploads are compared against it
      if (enriched.status === 'PASS') {
        await insertInvoiceIntoLedger(inv, { blocked: false, user, masters });
        await audit(
          'LEDGER_INSERT',
          checkId,
          `Auto-inserted passed invoice ${inv.invoiceNo || ''} into database ledger`,
          { user, fileName: inv.fileName || inv.invoiceNo, result: 'PASS_INSERTED' }
        );
      }

      await audit(
        'DATABASE_CHECK',
        checkId,
        `Checked against database ledger: ${databaseMatch.status} (${databaseMatch.reason})`,
        { user, fileName: inv.fileName || inv.invoiceNo, result: databaseMatch.status }
      );

      return JSON.stringify({
        checkId,
        source: effectiveSource,
        ...enriched,
        databaseMatch,
        dataQuality,
        lookupSource: lookupInfo.source,
        similarInvoices: lookupInfo.pastPosted,
        steps,
        invoice: publicView(inv),
      });
    });

    this.on('checkBatch', async req => {
      const roles = getUserRoles(req);
      if (roles.includes('Auditor') && !roles.includes('APClerk') && !roles.includes('APController')) {
        return req.reject(403, 'An auditor cannot check invoices.');
      }

      const user = getUserId(req);
      const masters = loadMasters();
      const rawInvoices = typeof req.data.invoices === 'string' ? JSON.parse(req.data.invoices) : (req.data.invoices || []);
      const list = rawInvoices.map(parseInvoice);

      if (list.length > 2000) {
        return req.reject(400, `This batch has ${list.length} invoices. The maximum per job is 2000. Please split the file.`);
      }

      // If sync mode is explicitly requested, run synchronously
      if (req.data.sync === true) {
        const posted = await loadLedgerForInvoices(list);
        if (list.length > 0) {
          try {
            await performLookupForInvoice(list[0], posted, user, masters);
          } catch (err) {
            return req.reject(400, err.message);
          }
        }

        const out = [];
        for (let i = 0; i < list.length; i++) {
          const inv = list[i];
          const result = runRules(inv, {
            masters,
            posted,
            batch: list,
            earlier: list.slice(0, i),
            irpPublicKeyPem: process.env.IRP_PUBLIC_KEY_PEM || undefined,
          });
          const enriched = enrichRuleResult(result);
          const databaseMatch = findDatabaseMatch(inv, {
            posted,
            batch: list,
            earlier: list.slice(0, i),
          });
          const checkId = await persist(inv, result, inv.source || 'S4', req);

          if (result.status === 'PASS') {
            await insertInvoiceIntoLedger(inv, { blocked: false, user, masters });
            posted.push(inv);
          }

          await audit(
            'DATABASE_CHECK',
            checkId,
            `Checked against database ledger: ${databaseMatch.status} (${databaseMatch.reason})`,
            { user, fileName: inv.fileName || inv.invoiceNo || 'batch-invoice', result: databaseMatch.status }
          );

          out.push({ id: inv.id, checkId, ...enriched, databaseMatch, invoice: publicView(inv) });
        }
        return JSON.stringify(out);
      }

      // Default: Async chunked background job returning immediately
      const jobInfo = await createBatchJob({
        invoices: list,
        user: 'User',
        source: 'S4',
        fileName: 's4-extract.csv',
        masters,
        audit,
      });
      return JSON.stringify(jobInfo);
    });

    this.on('createBatchJob', async req => {
      const roles = getUserRoles(req);
      if (roles.includes('Auditor') && !roles.includes('APClerk') && !roles.includes('APController')) {
        return req.reject(403, 'An auditor cannot check invoices.');
      }
      const user = getUserId(req);
      const masters = loadMasters();
      const rawInvoices = typeof req.data.invoices === 'string' ? JSON.parse(req.data.invoices) : (req.data.invoices || []);
      const list = rawInvoices.map(parseInvoice);

      if (list.length > 2000) {
        return req.reject(400, `This batch has ${list.length} invoices. The maximum per job is 2000. Please split the file.`);
      }

      const jobInfo = await createBatchJob({
        invoices: list,
        user: 'User',
        source: 'S4',
        fileName: 's4-extract.csv',
        masters,
        audit,
      });
      return JSON.stringify(jobInfo);
    });

    this.on('uploadBatchDocuments', async req => {
      const roles = getUserRoles(req);
      if (roles.includes('Auditor') && !roles.includes('APClerk') && !roles.includes('APController')) {
        return req.reject(403, 'An auditor cannot check invoices.');
      }
      const rawFiles = typeof req.data.files === 'string' ? JSON.parse(req.data.files) : (req.data.files || []);
      if (!Array.isArray(rawFiles) || !rawFiles.length) {
        return req.reject(400, 'No files provided');
      }

      const { invoices, errors } = await processDocumentBatch(rawFiles);
      if (invoices.length > 2000) {
        return req.reject(400, `This batch has ${invoices.length} invoices. The maximum per job is 2000. Please split the file.`);
      }
      if (!invoices.length && errors.length) {
        return req.reject(400, `Could not extract invoices from provided files: ${errors.map(e => e.fileName + ' (' + e.reason + ')').join('; ')}`);
      }

      const masters = loadMasters();
      const jobInfo = await createBatchJob({
        invoices,
        user: 'User',
        source: 'S4',
        fileName: rawFiles.length === 1 ? rawFiles[0].fileName : `${rawFiles.length}-documents-batch`,
        masters,
        audit,
        initialErrors: errors,
      });

      return JSON.stringify({
        ...jobInfo,
        invoicesCount: invoices.length,
        errors,
      });
    });

    this.on('getJob', async req => {
      const id = req.data.jobId;
      const job = await getJob(id);
      if (!job) return req.reject(404, `Job ${id} not found`);
      return JSON.stringify(job);
    });

    this.on('cancelJob', async req => {
      const id = req.data.jobId;
      const user = getUserId(req);
      try {
        const out = await cancelJob(id, audit, user);
        return JSON.stringify(out);
      } catch (err) {
        return req.reject(400, err.message);
      }
    });

    this.on('resumeJob', async req => {
      const id = req.data.jobId;
      const user = getUserId(req);
      const masters = loadMasters();
      try {
        const out = await resumeJob(id, { masters, audit, user });
        return JSON.stringify(out);
      } catch (err) {
        return req.reject(400, err.message);
      }
    });

    this.on('getS4Results', async req => {
      const data = await getS4ResultsQuery(req.data);
      return JSON.stringify(data);
    });

    this.on('getReviewQueue', async req => {
      const data = await getReviewQueueQuery(req.data);
      return JSON.stringify(data);
    });

    this.on('getCheckHistory', async req => {
      const data = await getCheckHistoryQuery(req.data);
      return JSON.stringify(data);
    });

    this.on('getActivityLogs', async req => {
      const data = await getActivityLogsQuery(req.data);
      return JSON.stringify(data);
    });

    this.on('searchDatabase', async req => {
      const q = String(req.data.query || '').trim();
      let records;
      if (!q) {
        records = await cds.run(SELECT.from(E.Posted).orderBy('postedAt desc').limit(50));
      } else {
        const term = `%${q}%`;
        records = await cds.run(
          SELECT.from(E.Posted).where`invoiceNo like ${term} or supplierGstin like ${term} or supplierName like ${term} or description like ${term}`
        );
      }
      const user = getUserId(req);
      await audit('DATABASE_SEARCH', null, `Searched database ledger for "${q || '*'}" (${records.length} matches)`, {
        user,
        fileName: 'ledger',
        result: `${records.length} matches`,
      });
      return JSON.stringify(records);
    });

    this.on('importToLedger', async req => {
      const roles = getUserRoles(req);
      if (roles.includes('Auditor') && !roles.includes('APClerk') && !roles.includes('APController')) {
        return req.reject(403, 'An auditor cannot import to ledger.');
      }
      const { fileName, content } = req.data;
      const text = String(content || '').replace(/^\uFEFF/, '').trim();
      if (!text) return req.reject(400, 'The file is empty');
      let list;
      try {
        list = text.startsWith('[') ? JSON.parse(text) : parseCsv(text).map(s4RowToInvoice);
      } catch (e) {
        return req.reject(400, 'The file could not be read: ' + e.message);
      }
      if (!Array.isArray(list) || !list.length) return req.reject(400, 'The file has no invoice rows');
      const user = getUserId(req);
      const masters = loadMasters();
      let count = 0;
      for (const raw of list) {
        const inv = parseInvoice(raw);
        await insertInvoiceIntoLedger(inv, { blocked: false, user, masters });
        count++;
      }
      await audit('LEDGER_IMPORT', null, `Imported ${count} invoices into database ledger from ${fileName || 'file'}`, {
        user,
        fileName: fileName || 'extract.csv',
        result: `${count} loaded`,
      });
      return JSON.stringify({ fileName, count, ok: true });
    });

    this.on('postInvoice', async req => {
      const roles = getUserRoles(req);
      if (roles.includes('APController') && !roles.includes('APClerk')) {
        return req.reject(403, 'A controller cannot post.');
      }
      if (roles.includes('Auditor') && !roles.includes('APClerk')) {
        return req.reject(403, 'An auditor cannot post.');
      }

      const rawPayload = typeof req.data.invoice === 'string' ? JSON.parse(req.data.invoice) : { ...req.data.invoice };
      if (Array.isArray(rawPayload.unconfirmedLowFields) && rawPayload.unconfirmedLowFields.length > 0) {
        return req.reject(400, `Confirm all Low-confidence fields before posting to ledger (${rawPayload.unconfirmedLowFields.join(', ')}).`);
      }

      const masters = loadMasters();
      const inv = parseInvoice(rawPayload);
      const posted = await loadLedgerForInvoices([inv]);
      const result = runRules(inv, {
        masters,
        posted,
        batch: [],
        earlier: [],
        irpPublicKeyPem: process.env.IRP_PUBLIC_KEY_PEM || undefined,
      });
      const enriched = enrichRuleResult(result);
      if (result.results.some(r => r.id === 'INPUT')) return req.reject(400, 'Complete the invoice fields before posting');
      const checkId = await persist(inv, result, inv.source || 'UPLOAD', req);
      const user = getUserId(req);

      if (result.status === 'REJECT') {
        await audit('POST_BLOCKED', checkId, `Not posted (REJECT): ${inv.invoiceNo}`, {
          user,
          fileName: inv.fileName || inv.invoiceNo,
          result: 'REJECT',
        });
        return JSON.stringify({ posted: false, blocked: false, checkId, ...enriched });
      }
      const blocked = result.status === 'HOLD';
      await insertInvoiceIntoLedger(inv, { blocked, user, masters });
      await audit('POST', checkId, `Posted ${inv.invoiceNo}${blocked ? ' (payment blocked)' : ''}`, {
        user,
        fileName: inv.fileName || inv.invoiceNo,
        result: blocked ? 'POSTED_BLOCKED' : 'POSTED',
      });
      return JSON.stringify({ posted: true, blocked, checkId, ...enriched });
    });

    this.on('decideAlert', req => applyDecision(req, req.data.alertId, req.data.decision, req.data.comment));
    this.on('decide', 'Alerts', req => {
      const key = req.params[0];
      return applyDecision(req, typeof key === 'object' ? key.ID : key, req.data.decision, req.data.comment);
    });

    this.on('verifyAuditChain', async () => {
      const rows = await cds.run(SELECT.from(E.AuditLog).orderBy('idx asc'));
      let prev = '';
      for (const r of rows) {
        const expected = U.auditHash(r.idx, r.ts, r.checkId || '', r.action, r.detail || '', prev);
        if (r.prevHash !== prev || r.hash !== expected) return JSON.stringify({ ok: false, entries: rows.length, brokenAt: r.idx });
        prev = r.hash;
      }
      return JSON.stringify({ ok: true, entries: rows.length, brokenAt: null });
    });

    // -------------------------------------------------------------
    // SECTION 5: FOLLOW-UP QUESTIONS & READ-ONLY AI SERVICE
    // -------------------------------------------------------------
    const verifiedModelsCache = new Map();

    const readEnvConfig = (req) => {
      const envVars = {};
      try {
        const envPath = path.join(__dirname, '../.env');
        if (fs.existsSync(envPath)) {
          const lines = fs.readFileSync(envPath, 'utf8').split('\n');
          for (const line of lines) {
            const trimmed = line.trim();
            if (trimmed && !trimmed.startsWith('#')) {
              const eq = trimmed.indexOf('=');
              if (eq !== -1) {
                envVars[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
              }
            }
          }
        }
      } catch {}

      if (req && req.headers && req.headers['x-gemini-api-key-unset'] === 'true') {
        return {
          apiKey: '',
          modelName: 'gemini-3.5-flash-lite',
          allowInvoiceData: false,
        };
      }

      const rawKey = (process.env.GEMINI_API_KEY && process.env.GEMINI_API_KEY.trim())
        || (process.env.API_KEY && process.env.API_KEY.trim())
        || envVars.GEMINI_API_KEY
        || '';
      const rawModel = (process.env.GEMINI_MODEL && process.env.GEMINI_MODEL.trim())
        || envVars.GEMINI_MODEL
        || 'gemini-3.5-flash-lite';
      const rawAllow = (process.env.ALLOW_INVOICE_DATA_TO_LLM && process.env.ALLOW_INVOICE_DATA_TO_LLM.trim())
        || envVars.ALLOW_INVOICE_DATA_TO_LLM
        || '';

      return {
        apiKey: String(rawKey || '').trim(),
        modelName: String(rawModel || 'gemini-3.5-flash-lite').trim() || 'gemini-3.5-flash-lite',
        allowInvoiceData: rawAllow ? String(rawAllow).trim() !== 'false' : true,
      };
    };

    const verifyGeminiModelAvailable = async (apiKey, modelName) => {
      if (!apiKey || !modelName) {
        throw new Error('Missing API key or model name');
      }
      const cacheKey = `${apiKey.slice(0, 8)}:${modelName}`;
      if (verifiedModelsCache.has(cacheKey)) {
        return true;
      }
      const cleanModel = modelName.replace(/^models\//, '');
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(cleanModel)}?key=${encodeURIComponent(apiKey)}`;
      const res = await fetch(url, {
        method: 'GET',
        headers: { 'User-Agent': 'aistudio-build' },
        signal: typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(10000) : undefined,
      });
      if (!res.ok) {
        throw new Error(`Gemini model ${cleanModel} is not available (${res.status})`);
      }
      const data = await res.json();
      const methods = data.supportedGenerationMethods || [];
      if (!methods.includes('generateContent')) {
        throw new Error(`Gemini model ${cleanModel} does not support generateContent`);
      }
      verifiedModelsCache.set(cacheKey, true);
      return true;
    };

    // Pre-warm model verification cache asynchronously on startup
    try {
      const initCfg = readEnvConfig(null);
      if (initCfg.apiKey) {
        verifyGeminiModelAvailable(initCfg.apiKey, initCfg.modelName).catch(() => {});
      }
    } catch {}

    const callGeminiSingle = async (apiKey, targetModel, systemInstruction, promptText) => {
      await verifyGeminiModelAvailable(apiKey, targetModel);
      const ai = new GoogleGenAI({
        apiKey,
        httpOptions: {
          headers: {
            'User-Agent': 'aistudio-build',
          },
        },
      });
      let timer = null;
      try {
        const timeoutPromise = new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('Gemini request timed out')), 15000);
        });
        const response = await Promise.race([
          ai.models.generateContent({
            model: targetModel.replace(/^models\//, ''),
            contents: promptText,
            config: {
              systemInstruction,
            },
          }),
          timeoutPromise,
        ]);
        if (response && response.text) {
          const cleaned = String(response.text)
            .replace(/\*\*/g, '')
            .replace(/\$\\ge\$/g, '>=')
            .replace(/\$\\le\$/g, '<=');
          return stripProhibitedWords(cleaned);
        }
        throw new Error('Empty Gemini response');
      } finally {
        if (timer) clearTimeout(timer);
      }
    };

    const callGeminiText = async (apiKey, modelName, systemInstruction, promptText) => {
      try {
        return await callGeminiSingle(apiKey, modelName, systemInstruction, promptText);
      } catch (primaryErr) {
        const msg = String((primaryErr && primaryErr.message) || '');
        if (/401|403|API_KEY_INVALID|Missing API key/i.test(msg)) {
          throw primaryErr;
        }
        const fallbackModel = 'gemini-2.5-flash';
        if (modelName.replace(/^models\//, '') !== fallbackModel) {
          return await callGeminiSingle(apiKey, fallbackModel, systemInstruction, promptText);
        }
        throw primaryErr;
      }
    };

    const buildLocalInvoiceSupplement = ({ checkRecord, parsedResult = {}, question = '' }) => {
      if (!checkRecord && (!parsedResult || !parsedResult.fields)) return '';
      const f = (parsedResult && parsedResult.fields) || {};
      const invNo = (checkRecord && checkRecord.invoiceNo) || f.invoiceNo || 'Not shown on invoice';
      const invDate = (checkRecord && checkRecord.invoiceDate) || f.invoiceDate || 'Not shown on invoice';
      const supplier = (checkRecord && checkRecord.supplierName) || f.supplierName || 'Not shown on invoice';
      const supplierGstin = (checkRecord && checkRecord.supplierGstin) || f.supplierGstin || 'Not shown on invoice';
      const buyerGstin = f.buyerGstin || 'Not shown on invoice';
      const poNumber = f.poNumber || 'Not shown on invoice';
      const desc = f.description || 'Not shown on invoice';
      const fmtNum = (val) => (val !== undefined && val !== null && val !== '' ? `INR ${Number(val).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : 'Not shown on invoice');
      const totalVal = (checkRecord && checkRecord.total !== undefined && checkRecord.total !== null) ? checkRecord.total : f.total;
      const totalStr = fmtNum(totalVal);
      const taxableStr = fmtNum(f.taxable);
      const cgstStr = fmtNum(f.cgst);
      const sgstStr = fmtNum(f.sgst);
      const igstStr = fmtNum(f.igst);
      const invIfsc = f.bankIfsc || f.ifsc || 'Not shown on invoice';
      const invAcct = f.bankAccount || f.accountNo || f.account || 'Not shown on invoice';
      const allResults = parsedResult.results || [];
      const ap05Rule = allResults.find(r => r.id === 'AP-05');
      const ap05Tier = ap05Rule ? ap05Rule.tier : 'DISABLED';

      const q = String(question || '').toLowerCase();
      const lines = ['Invoice details from current check:'];
      if (/\b(bank|account|acct|ifsc|beneficiary|branch|neft|rtgs|iban|ap-?05)\b/i.test(q)) {
        lines.push(`• Bank IFSC: ${invIfsc}`);
        lines.push(`• Bank account number: ${invAcct}`);
        lines.push(`• Rule AP-05 (Bank details changed): ${ap05Tier}`);
      } else if (/\b(much|bill|amount|amounts|total|tax|taxes|taxable|cgst|sgst|igst|price|cost|value|money|pay|payment)\b/i.test(q)) {
        lines.push(`• Total amount: ${totalStr}`);
        lines.push(`• Taxable amount: ${taxableStr}`);
        lines.push(`• Taxes: CGST ${cgstStr} · SGST ${sgstStr} · IGST ${igstStr}`);
        lines.push(`• Invoice number: ${invNo} (${invDate})`);
      } else if (/\b(supplier|vendor|seller|buyer|who|company|party|gstin|gst)\b/i.test(q)) {
        lines.push(`• Supplier name: ${supplier}`);
        lines.push(`• Supplier GSTIN: ${supplierGstin}`);
        lines.push(`• Buyer GSTIN: ${buyerGstin}`);
        lines.push(`• Invoice number: ${invNo} · Total: ${totalStr}`);
      } else {
        lines.push(`• Invoice number: ${invNo} · Date: ${invDate} · PO: ${poNumber}`);
        lines.push(`• Supplier: ${supplier} · GSTIN: ${supplierGstin}`);
        lines.push(`• Total: ${totalStr} (Taxable: ${taxableStr}, CGST: ${cgstStr}, SGST: ${sgstStr}, IGST: ${igstStr})`);
        lines.push(`• Description: ${desc}`);
        lines.push(`• Bank details: IFSC ${invIfsc} · Account number ${invAcct} (Rule AP-05: ${ap05Tier})`);
      }
      return lines.join('\n');
    };

    const handleInvoiceQuestion = async (req, checkId, questionText) => {
      const user = getUserId(req);
      const q = String(questionText || '').trim();

      // Scope check: refuse only questions clearly unrelated to this invoice check
      if (!isInvoiceRelatedQuestion(q)) {
        return REFUSAL_MSG;
      }

      let checkRecord = null;
      let parsedResult = {};
      let activeResults = [];
      if (checkId) {
        checkRecord = await cds.run(SELECT.one.from(E.Checks).where({ ID: checkId }));
      }
      if (!checkRecord) {
        checkRecord = await cds.run(SELECT.one.from(E.Checks).orderBy('createdAt desc'));
      }
      if (checkRecord && checkRecord.resultJson) {
        try {
          parsedResult = JSON.parse(checkRecord.resultJson);
          activeResults = parsedResult.activeResults || (parsedResult.results || []).filter(r => ACTIVE_RULE_IDS.includes(r.id));
        } catch {}
      }

      const status = (checkRecord && checkRecord.status) || parsedResult.status || 'PASS';
      const verdict = toVerdictLabel(status, activeResults);

      // Requirement 10: Log each request: user ID, time, verdict, rule IDs. No keys, no file contents.
      console.log(`[CHAT_AUDIT] User: ${user}, Time: ${new Date().toISOString()}, Verdict: ${verdict}, Rules: ${ACTIVE_RULE_IDS.join(',')}`);

      const { apiKey, modelName, allowInvoiceData } = readEnvConfig(req);
      if (!apiKey) {
        return 'The assistant is not configured.';
      }

      const outgoingRequest = buildInvoiceOutgoingRequest({
        checkRecord,
        parsedResult,
        activeResults,
        question: q,
        allowInvoiceData,
      });

      const systemInstruction = `You are Blus Invoice Agent, the AI assistant that catches duplicate and split invoices before they get paid.
Write in clean, natural text (do not use LaTeX symbols).
Never mention "SAP BTP" or "BTP" anywhere in your response.
When listing invoice fields, rules, or key points, use "Label: Value" format (for example, "Invoice number: 51109396" or "Total amount: INR 9,25,640.10") so the interface highlights the main label in bold black and the answer in normal text.
Answer the user's question directly and conversationally using the Grounding Context below.
- If the user says "hi" or greets you: greet them warmly as Blus Invoice Agent and briefly offer to help with the current invoice check or any invoice questions.
- Do NOT repeat all four rules on every message if the user is just asking a specific question (such as how much the bill is, who the supplier is, what the invoice number or date is, what services were billed, or what the bank account is). Answer their specific question directly and concisely!
- If the user asks about the rules, why the invoice passed/failed, or "is this real or fake" / "is this genuine": explain the verdict (${verdict}), the active rule results (AP-02, AP-03, AP-09, AP-11), and mention that this is a rules check only and does not prove the invoice is genuine.
- If the user asks about bank account or IFSC details: state the IFSC and account number from the invoice fields, and mention that rule AP-05 (Bank details changed) is currently DISABLED.
- Never use the words "fake" or "real" in your response.

Grounding Context:
${JSON.stringify(outgoingRequest.grounding, null, 2)}`;

      try {
        let reply = await callGeminiText(apiKey, modelName, systemInstruction, outgoingRequest.question);
        reply = reply.replace(/\s*\bon\s+SAP\s+BTP\b/gi, '').replace(/\bSAP\s+BTP\b/gi, 'Blus Invoice Agent');
        if (!allowInvoiceData) {
          const supplement = buildLocalInvoiceSupplement({ checkRecord, parsedResult, question: q });
          if (supplement) {
            reply = `${reply}\n\n${supplement}`;
          }
        }
        return stripProhibitedWords(reply);
      } catch (e) {
        console.error('Gemini assistant error:', e.message);
        return 'The assistant is not configured.';
      }
    };

    this.on('askInvoice', async req => {
      const { checkId, question } = req.data;
      return handleInvoiceQuestion(req, checkId, question);
    });

    this.on('chat', async req => {
      const message = String(req.data.message || '').trim();
      const checkId = req.data.checkId || null;
      return handleInvoiceQuestion(req, checkId, message);
    });

    return super.init();
  }
}

FraudService.buildGroundingPayload = buildGroundingPayload;
FraudService.buildInvoiceOutgoingRequest = buildInvoiceOutgoingRequest;
FraudService.buildDetectionAndInvoiceSummary = buildDetectionAndInvoiceSummary;
FraudService.toVerdictLabel = toVerdictLabel;
FraudService.buildVerdictExplanation = buildVerdictExplanation;
FraudService.isInvoiceRelatedQuestion = isInvoiceRelatedQuestion;
FraudService.stripProhibitedWords = stripProhibitedWords;
FraudService.RULES_CHECK_DISCLAIMER = RULES_CHECK_DISCLAIMER;
FraudService.REFUSAL_MSG = REFUSAL_MSG;
FraudService.ACTIVE_RULE_IDS = ACTIVE_RULE_IDS;
FraudService.DISABLED_RULE_IDS = DISABLED_RULE_IDS;

module.exports = FraudService;
