'use strict';
const cds = require('@sap/cds');
const crypto = require('crypto');
const U = require('../rules/util');

function formatMoney(n) {
  if (n === undefined || n === null || n === '') return '-';
  const num = Number(n);
  if (Number.isNaN(num)) return String(n);
  return num.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/**
 * Loads existing ledger records from ap.Posted for given invoices using indexed lookups
 * by supplier GSTIN list, avoiding full-table scans.
 */
async function loadLedgerForInvoices(invoices = []) {
  const list = Array.isArray(invoices) ? invoices : [invoices];
  const gstins = [...new Set(list.map(i => U.norm(i.supplierGstin || i.supplierId)).filter(Boolean))];

  if (gstins.length === 0) {
    return await cds.run(SELECT.from('ap.Posted').limit(500));
  }

  // Uses HANA/SQLite index on supplierGstin
  const posted = await cds.run(
    SELECT.from('ap.Posted').where({ supplierGstin: { in: gstins } })
  );
  return posted || [];
}

function supplierMatchKey(x) {
  return U.norm(x.supplierGstin || x.SupplierGSTIN || x.supplierId || x.InvoicingParty || x.supplierName);
}

/**
 * Evaluates whether an invoice matches any existing record in the ledger or inside the same batch.
 * Returns a plain-language match object without rule codes:
 * - "Found in database" with the matching ledger record (invoice number, supplier, GSTIN, date, amount)
 *   and the plain reason it matched (same invoice number / same GSTIN / same vendor + amount + service / split pattern).
 * - "Not found in database" if there is no match.
 */
function findDatabaseMatch(inv, { posted = [], batch = [], earlier = [] } = {}) {
  const normSupp = supplierMatchKey(inv);
  const normInvNo = U.normInvoiceNo(inv.invoiceNo || inv.SupplierInvoice);
  const invTotal = U.num(inv.total ?? inv.InvoiceGrossAmount);
  const invDate = inv.invoiceDate || inv.InvoiceDate || inv.PostingDate || inv.postingDate;
  const fy = invDate ? U.fiscalYear(invDate) : (inv.FiscalYear || inv.fiscalYear || 'UNKNOWN');

  const formatRecord = (r) => ({
    invoiceNo: r.invoiceNo || r.SupplierInvoice || '-',
    supplierName: r.supplierName || r.InvoicingParty || inv.supplierName || inv.InvoicingParty || 'Supplier',
    supplierGstin: r.supplierGstin || r.SupplierGSTIN || '-',
    invoiceDate: r.invoiceDate || r.InvoiceDate || r.PostingDate || '-',
    total: (r.total ?? r.InvoiceGrossAmount) !== undefined && (r.total ?? r.InvoiceGrossAmount) !== null ? Number(r.total ?? r.InvoiceGrossAmount) : null,
    totalFormatted: `INR ${formatMoney(r.total ?? r.InvoiceGrossAmount)}`,
  });

  // Check 1: Same invoice number in the database ledger
  const dupKey = U.dupKeyOf(inv);
  const exactLedgerMatch = (posted || []).find(p => {
    if (inv.irn && p.irn && p.irn === inv.irn) return true;
    if (U.dupKeyOf(p) === dupKey) return true;
    if (normInvNo && U.normInvoiceNo(p.invoiceNo || p.SupplierInvoice) === normInvNo && supplierMatchKey(p) === normSupp) {
      if (p.fiscalYear && fy && p.fiscalYear === fy) return true;
      const pDate = p.invoiceDate || p.InvoiceDate || p.PostingDate;
      if (!p.fiscalYear && pDate && U.fiscalYear(pDate) === fy) return true;
    }
    return false;
  });

  if (exactLedgerMatch) {
    const rec = formatRecord(exactLedgerMatch);
    return {
      matched: true,
      status: 'Found in database',
      reason: 'Same invoice number',
      record: rec,
      summary: `Matches invoice ${rec.invoiceNo} (${rec.supplierName}, GSTIN: ${rec.supplierGstin}, Date: ${rec.invoiceDate}, Amount: ${rec.totalFormatted}) due to same invoice number`,
      source: 'database',
    };
  }

  // Check 2: Same vendor, amount and service within 90 days in the ledger
  const repeatLedgerMatch = (posted || []).find(p =>
    supplierMatchKey(p) === normSupp &&
    U.num(p.total ?? p.InvoiceGrossAmount) === invTotal &&
    U.daysBetween(p.invoiceDate || p.InvoiceDate || p.PostingDate, invDate) <= 90 &&
    U.normInvoiceNo(p.invoiceNo || p.SupplierInvoice) !== normInvNo &&
    U.similarity(p.description || p.SupplierInvoiceIDByInvcgParty || p.DocumentHeaderText, inv.description || inv.SupplierInvoiceIDByInvcgParty || inv.DocumentHeaderText) >= 0.9
  );

  if (repeatLedgerMatch) {
    const rec = formatRecord(repeatLedgerMatch);
    return {
      matched: true,
      status: 'Found in database',
      reason: 'Same vendor, amount and service',
      record: rec,
      summary: `Matches invoice ${rec.invoiceNo} (${rec.supplierName}, GSTIN: ${rec.supplierGstin}, Date: ${rec.invoiceDate}, Amount: ${rec.totalFormatted}) due to same vendor, amount and service`,
      source: 'database',
    };
  }

  // Check 3: Split invoice pattern against approval limits in ledger
  const splitLedgerMatch = (posted || []).find(p => {
    if (supplierMatchKey(p) !== normSupp) return false;
    if (U.daysBetween(p.invoiceDate || p.InvoiceDate || p.PostingDate, invDate) > 14) return false;
    const pAmt = U.num(p.total ?? p.InvoiceGrossAmount);
    const levels = [100000, 500000];
    return levels.some(limit => {
      const isBand = (pAmt >= limit * 0.95 && pAmt < limit) && (invTotal >= limit * 0.95 && invTotal < limit);
      return isBand && (pAmt + invTotal >= limit);
    });
  });

  if (splitLedgerMatch) {
    const rec = formatRecord(splitLedgerMatch);
    return {
      matched: true,
      status: 'Found in database',
      reason: 'Split pattern against approval limit',
      record: rec,
      summary: `Matches invoice ${rec.invoiceNo} (${rec.supplierName}, GSTIN: ${rec.supplierGstin}, Date: ${rec.invoiceDate}, Amount: ${rec.totalFormatted}) due to split pattern against approval limit`,
      source: 'database',
    };
  }

  // Check 4: Matches inside the same batch (earlier rows in same upload)
  const exactBatchMatch = (earlier || []).find(b => {
    if (b === inv) return false;
    const bDate = b.invoiceDate || b.InvoiceDate || b.PostingDate;
    const bFy = bDate ? U.fiscalYear(bDate) : (b.FiscalYear || b.fiscalYear || 'UNKNOWN');
    return supplierMatchKey(b) === normSupp &&
      U.normInvoiceNo(b.invoiceNo || b.SupplierInvoice) === normInvNo &&
      bFy === fy;
  });

  if (exactBatchMatch) {
    const rec = formatRecord(exactBatchMatch);
    return {
      matched: true,
      status: 'Found in database',
      reason: 'Same invoice number in batch',
      record: rec,
      summary: `Matches batch invoice ${rec.invoiceNo} (${rec.supplierName}, GSTIN: ${rec.supplierGstin}, Date: ${rec.invoiceDate}, Amount: ${rec.totalFormatted}) due to duplicate in same upload`,
      source: 'batch',
    };
  }

  const repeatBatchMatch = (batch || []).find(b =>
    b !== inv &&
    supplierMatchKey(b) === normSupp &&
    U.num(b.total ?? b.InvoiceGrossAmount) === invTotal &&
    U.daysBetween(b.invoiceDate || b.InvoiceDate || b.PostingDate, invDate) <= 90 &&
    U.normInvoiceNo(b.invoiceNo || b.SupplierInvoice) !== normInvNo &&
    U.similarity(b.description || b.SupplierInvoiceIDByInvcgParty || b.DocumentHeaderText, inv.description || inv.SupplierInvoiceIDByInvcgParty || inv.DocumentHeaderText) >= 0.9
  );

  if (repeatBatchMatch) {
    const rec = formatRecord(repeatBatchMatch);
    return {
      matched: true,
      status: 'Found in database',
      reason: 'Same vendor, amount and service in batch',
      record: rec,
      summary: `Matches batch invoice ${rec.invoiceNo} (${rec.supplierName}, GSTIN: ${rec.supplierGstin}, Date: ${rec.invoiceDate}, Amount: ${rec.totalFormatted}) due to repeat bill in same upload`,
      source: 'batch',
    };
  }

  return {
    matched: false,
    status: 'Not found in database',
    reason: 'No match in database',
    record: null,
    summary: 'Not found in database',
    source: null,
  };
}

function normalizeLedgerSource(rawSource) {
  const s = String(rawSource || '').trim().toUpperCase();
  if (s === 'IMPORT' || s === 'LEDGER_IMPORT') return 'Import';
  if (s === 'BATCH' || s === 'S4') return 'Batch';
  if (s === 'CHAT' || s === 'UPLOAD') return 'Chat';
  return 'Chat';
}

/**
 * Inserts a PASS (or cleared/posted) invoice into the HANA ledger (ap.Posted).
 */
async function insertInvoiceIntoLedger(inv, { blocked = false, user = 'reviewer', source = '' } = {}) {
  const invDate = inv.invoiceDate || inv.InvoiceDate || inv.PostingDate || inv.postingDate || null;
  const rawFy = invDate ? U.fiscalYear(invDate) : (inv.FiscalYear || inv.fiscalYear || 'UNKNOWN');
  const fy = String(rawFy || 'UNKNOWN').slice(0, 10);
  const rawInvNo = inv.invoiceNo || inv.SupplierInvoice || null;
  const invNo = rawInvNo ? String(rawInvNo).trim().slice(0, 60) : null;
  const rawGstin = inv.supplierGstin || inv.SupplierGSTIN || null;
  const suppGstin = rawGstin ? String(rawGstin).trim().toUpperCase().slice(0, 15) : null;
  const rawSuppName = inv.supplierName || inv.InvoicingParty || null;
  const suppName = rawSuppName ? String(rawSuppName).trim().slice(0, 120) : null;
  const totalVal = inv.total ?? inv.InvoiceGrossAmount;
  const normalizedSource = normalizeLedgerSource(source || inv.ledgerSource || inv.source || 'Chat');
  const safeDesc = String(inv.description || inv.SupplierInvoiceIDByInvcgParty || inv.DocumentHeaderText || '').trim().slice(0, 250);
  const safeIrn = inv.irn ? String(inv.irn).trim().slice(0, 64) : null;

  const whereCond = suppGstin
    ? { supplierGstin: suppGstin, invoiceNo: invNo, fiscalYear: fy }
    : { supplierName: suppName, invoiceNo: invNo, fiscalYear: fy };

  const existing = await cds.run(
    SELECT.one.from('ap.Posted').where(whereCond)
  );

  if (existing) {
    const existingId = existing.ID || existing.id;
    const updates = {};
    if ((existing.blocked || existing.BLOCKED) && !blocked) updates.blocked = false;
    if (!(existing.source || existing.SOURCE) && normalizedSource) updates.source = normalizedSource;
    if (Object.keys(updates).length > 0 && existingId) {
      await cds.run(UPDATE('ap.Posted').set(updates).where({ ID: existingId }));
    }
    return existingId;
  }

  const id = crypto.randomUUID();
  await cds.run(INSERT.into('ap.Posted').entries({
    ID: id,
    invoiceNo: invNo,
    supplierGstin: suppGstin,
    fiscalYear: fy,
    invoiceDate: invDate,
    total: totalVal !== undefined && totalVal !== null ? Number(totalVal) : 0,
    supplierName: suppName,
    description: safeDesc,
    irn: safeIrn,
    blocked,
    recurringPo: Boolean(inv.recurringPo),
    postedAt: new Date().toISOString(),
    source: normalizedSource,
  }));
  return id;
}

module.exports = {
  loadLedgerForInvoices,
  findDatabaseMatch,
  insertInvoiceIntoLedger,
  normalizeLedgerSource,
  formatMoney,
};

