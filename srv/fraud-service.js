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

const s4Invoices = require('../data/s4-invoices.json');

const NUMERIC = ['taxable', 'cgst', 'sgst', 'igst', 'cess', 'vat', 'total'];
const DECISIONS = ['CLEAR', 'CONFIRM', 'ESCALATE'];
const ROLES = ['APClerk', 'APController', 'Auditor'];
const ACTIVE_RULE_IDS = ['AP-02', 'AP-03', 'AP-09', 'AP-11'];
const DISABLED_RULE_IDS = ['AP-01', 'AP-04', 'AP-05', 'AP-06', 'AP-07', 'AP-08', 'AP-10', 'AP-12', 'AP-13', 'AP-14'];

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
 * Builds the grounding payload sent to Gemini.
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
  const results = res.results || [];
  const activeResults = results.filter(r => ACTIVE_RULE_IDS.includes(r.id));
  const disabledResults = results.filter(r => r.tier === 'DISABLED');
  return {
    ...res,
    activeResults,
    disabledRulesCount: disabledResults.length || 10,
  };
}

async function performLookupForInvoice(inv, posted, user, masters) {
  // Executes lookup layer functions (honours CLIENT_DB_LOOKUP_ENABLED)
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

    const persist = async (inv, result, source, req) => {
      const user = req ? getUserId(req) : 'reviewer';
      const checkId = crypto.randomUUID();
      const enriched = enrichRuleResult(result);
      await cds.run(INSERT.into(E.Checks).entries({
        ID: checkId,
        createdAt: new Date().toISOString(),
        createdBy: user,
        source,
        fileName: inv.fileName || null,
        supplierName: inv.supplierName || null,
        supplierGstin: inv.supplierGstin || null,
        invoiceNo: inv.invoiceNo || null,
        invoiceDate: inv.invoiceDate || null,
        total: inv.total ?? null,
        status: result.status,
        resultJson: JSON.stringify(enriched),
      }));
      await cds.run(INSERT.into(E.CheckResults).entries(result.results.map(r => ({
        ID: crypto.randomUUID(),
        check_ID: checkId,
        ruleId: r.id,
        title: r.title,
        tier: r.tier,
        text: r.text,
      }))));
      const alerts = result.results.filter(r => ['REJECT', 'HOLD', 'FLAG'].includes(r.tier));
      for (const r of alerts) {
        r.alertId = crypto.randomUUID();
        await cds.run(INSERT.into(E.Alerts).entries({
          ID: r.alertId,
          createdAt: new Date().toISOString(),
          createdBy: user,
          check_ID: checkId,
          ruleId: r.id,
          title: r.title,
          tier: r.tier,
          text: r.text,
          decision: 'OPEN',
        }));
      }
      await audit(
        'CHECK',
        checkId,
        `${result.status} ${inv.invoiceNo || ''}: ${alerts.map(a => a.id).join(', ') || 'no alerts'}`,
        { user, fileName: inv.fileName || inv.invoiceNo || source, result: result.status }
      );
      return checkId;
    };

    const applyDecision = async (req, alertId, decision, comment) => {
      const roles = getUserRoles(req);
      // RBAC: A clerk cannot decide an alert. An auditor cannot decide. Only APController can decide.
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
      const user = getUserId(req);
      await audit('IMPORT', null, `${fileName || 'extract'}: ${list.length} rows`, {
        user,
        fileName: fileName || 's4-extract.csv',
        result: `${list.length} rows`,
      });
      return JSON.stringify({ fileName, count: list.length, invoices: list.map(i => ({ ...i, source: 'S4' })) });
    });

    // Full upload + extraction + 10-step check pipeline supporting PDF, PNG, and JPG
    const handleDocumentUpload = async (req, { fileName, fileSize, fileBase64, runCheck = true }) => {
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
      } else {
        // PNG or JPG image
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

      const fields = extractFields(text);
      if (qrJwt) fields.qrJwt = qrJwt;
      const threshold = (masters.config && masters.config.ocrLowConfidenceThreshold) || 70;
      const fieldConfidences = computeFieldConfidences(fields, {
        ocrUsed,
        ocrConfidence,
        words: ocrWords,
        threshold,
      });

      const inv = parseInvoice({
        ...fields,
        fileName,
        pdfText: text,
        pdfMeta: detection.kind === 'PDF' ? readPdfMeta(buf) : { producer: detection.kind, creator: '' },
        source: 'UPLOAD',
      });

      const posted = await cds.run(SELECT.from(E.Posted));
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
      const checkId = runCheck ? await persist(inv, rawResult, 'UPLOAD', req) : null;

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
        checkId,
      });

      return JSON.stringify({
        ok: true,
        checkId,
        fileName,
        fileSize: actualSize,
        fileType: fileTypeLabel,
        fields,
        fieldConfidences,
        dataQuality,
        lookupSource: lookupInfo.source,
        similarInvoices: lookupInfo.pastPosted,
        pdfText: text,
        pdfMeta: inv.pdfMeta,
        qrFound: Boolean(qrJwt),
        ocrUsed,
        ocrConfidence,
        warning,
        status: enriched.status,
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
      });
    });

    this.on('uploadDocument', async req => {
      const { fileName, fileSize, fileBase64 } = req.data;
      return handleDocumentUpload(req, {
        fileName,
        fileSize,
        fileBase64,
        runCheck: true,
      });
    });

    this.on('checkInvoice', async req => {
      const roles = getUserRoles(req);
      // RBAC: An auditor cannot check
      if (roles.includes('Auditor') && !roles.includes('APClerk') && !roles.includes('APController')) {
        return req.reject(403, 'An auditor cannot check invoices.');
      }

      const user = getUserId(req);
      const masters = loadMasters();
      const inv = parseInvoice(req.data.invoice);
      const posted = await cds.run(SELECT.from(E.Posted));

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
      const checkId = await persist(inv, result, inv.source || 'UPLOAD', req);

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
        checkId,
      });

      return JSON.stringify({
        checkId,
        ...enriched,
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
      const list = JSON.parse(req.data.invoices).map(parseInvoice);
      const posted = await cds.run(SELECT.from(E.Posted));

      // Verify lookup layer availability once before batch
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
        const checkId = await persist(inv, result, inv.source || 'S4', req);
        out.push({ id: inv.id, checkId, ...enriched, invoice: publicView(inv) });
      }
      return JSON.stringify(out);
    });

    this.on('postInvoice', async req => {
      const roles = getUserRoles(req);
      // RBAC: A controller cannot post (unless they also hold APClerk). An auditor cannot post.
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
      const posted = await cds.run(SELECT.from(E.Posted));
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
      await cds.run(INSERT.into(E.Posted).entries({
        invoiceNo: inv.invoiceNo,
        supplierGstin: inv.supplierGstin,
        invoiceDate: inv.invoiceDate,
        total: inv.total,
        description: inv.description || '',
        irn: inv.irn || null,
        blocked,
        recurringPo: isRecurring(inv, masters),
        postedAt: new Date().toISOString(),
      }));
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
    // SECTION 5: AI ASSISTANT (Read-only, Server-side)
    // -------------------------------------------------------------
    this.on('chat', async req => {
      const user = getUserId(req);
      const activeRules = ACTIVE_RULE_IDS;

      // 5.5 Log each chat request: user ID, time, rule IDs used. Never log prompt text or key.
      console.log(`[CHAT_AUDIT] User: ${user}, Time: ${new Date().toISOString()}, Rules: ${activeRules.join(',')}`);

      const apiKey = process.env.GEMINI_API_KEY;
      if (!apiKey || apiKey.trim() === '') {
        return 'The assistant is not configured.';
      }

      const allowInvoiceData = process.env.ALLOW_INVOICE_DATA_TO_LLM === 'true';

      // Gather database grounding context
      const posted = await cds.run(SELECT.from(E.Posted));
      const alerts = await cds.run(SELECT.from(E.Alerts));
      const checks = await cds.run(SELECT.from(E.Checks));
      const auditRows = await cds.run(SELECT.from(E.AuditLog).orderBy('idx asc'));

      let auditChainValid = true;
      let prev = '';
      for (const r of auditRows) {
        const expected = U.auditHash(r.idx, r.ts, r.checkId || '', r.action, r.detail || '', prev);
        if (r.prevHash !== prev || r.hash !== expected) {
          auditChainValid = false;
          break;
        }
        prev = r.hash;
      }

      const groundingPayload = buildGroundingPayload(
        { posted, alerts, checks, auditRows, auditChainValid },
        allowInvoiceData
      );

      const systemInstruction = `You are the read-only AI Assistant for AP Sentinel on SAP BTP.
Active fraud rules:
- AP-02 Exact duplicate: Same supplier GSTIN, same financial year (April to March), same normalised invoice number, or same IRN. Outcome: REJECT.
- AP-03 GSTIN reuse: One GSTIN registered to more than one vendor ID (unless on the parent/affiliate exemption list). Outcome: REJECT.
- AP-09 Same vendor, amount and services: Same supplier, same amount, description similarity >= 90%, within 90 days (recurring contract POs excluded). Outcome: REJECT (overridable only by CFO and Controller together with a logged reason).
- AP-11 Split invoices: Two or more bills from one vendor within 14 days, each in the 5% band below an approval limit, whose total reaches the limit (>= 1,00,000 INR). Outcome: HOLD.
(The other 10 rules AP-01, AP-04 to AP-08, AP-10, AP-12 to AP-14 are disabled by configuration).

Current Database Grounding Context:
${JSON.stringify(groundingPayload, null, 2)}

Allowed actions:
- Explain why an invoice or alert was put on HOLD or REJECT using the rule text.
- Help a reviewer choose CLEAR, CONFIRM or ESCALATE and draft a comment (the reviewer makes the final decision).
- Answer status questions accurately using the counts in the database grounding context (e.g. blockedInvoicesCount, openAlertsCount).
- Draft a discrepancy email to a vendor as plain text only (start with "Subject:" so the user can copy it).
- Explain the audit-chain verification result in plain language.

Forbidden:
- Never post, clear, confirm, or escalate anything.
- Never change master data or call S/4HANA.
- Never access raw PDFs or image files.`;

      try {
        const ai = new GoogleGenAI({
          apiKey,
          httpOptions: {
            headers: { 'User-Agent': 'aistudio-build' },
          },
        });

        // 5.1 Model name comes from GEMINI_MODEL. Verify that the model is available to the account before use. Do not hard-code a model name.
        let modelName = process.env.GEMINI_MODEL ? process.env.GEMINI_MODEL.trim() : '';
        if (modelName) {
          await ai.models.get({ model: modelName });
        } else {
          // Dynamically discover an available Flash model from the account without hard-coding a model name
          const pager = await ai.models.list();
          const available = [];
          for await (const m of pager) {
            if (m && m.name) available.push(m.name.replace(/^models\//, ''));
          }
          const flashModel = available.find(n => /gemini/i.test(n) && /flash/i.test(n) && !/image|tts|audio|thinking/i.test(n));
          if (!flashModel) {
            return 'The assistant is not configured.';
          }
          modelName = flashModel;
          await ai.models.get({ model: modelName });
        }

        const response = await ai.models.generateContent({
          model: modelName,
          contents: String(req.data.message || ''),
          config: { systemInstruction },
        });

        return response.text || 'No response generated.';
      } catch (e) {
        console.error('Gemini assistant error:', e.message);
        return 'The assistant is not configured.';
      }
    });

    return super.init();
  }
}

FraudService.buildGroundingPayload = buildGroundingPayload;
FraudService.ACTIVE_RULE_IDS = ACTIVE_RULE_IDS;
FraudService.DISABLED_RULE_IDS = DISABLED_RULE_IDS;

module.exports = FraudService;
