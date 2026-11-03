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

/**
 * Evaluates whether an invoice matches any existing record in the ledger or inside the same batch.
 * Returns a plain-language match object without rule codes:
 * - "Found in database" with the matching ledger record (invoice number, supplier, GSTIN, date, amount)
 *   and the plain reason it matched (same invoice number / same GSTIN / same vendor + amount + service / split pattern).
 * - "Not found in database" if there is no match.
 */
function findDatabaseMatch(inv, { posted = [], batch = [], earlier = [] } = {}) {
  const normGstin = U.norm(inv.supplierGstin || inv.supplierId);
  const normInvNo = U.normInvoiceNo(inv.invoiceNo);
  const invTotal = U.num(inv.total);
  const invDate = inv.invoiceDate;
  const fy = U.fiscalYear(invDate);

  const formatRecord = (r) => ({
    invoiceNo: r.invoiceNo || '-',
    supplierName: r.supplierName || inv.supplierName || 'Supplier',
    supplierGstin: r.supplierGstin || '-',
    invoiceDate: r.invoiceDate || '-',
    total: r.total !== undefined && r.total !== null ? Number(r.total) : null,
    totalFormatted: `INR ${formatMoney(r.total)}`,
  });

  // Check 1: Same invoice number in the database ledger
  const dupKey = U.dupKeyOf(inv);
  const exactLedgerMatch = (posted || []).find(p => {
    if (inv.irn && p.irn && p.irn === inv.irn) return true;
    if (U.dupKeyOf(p) === dupKey) return true;
    if (normInvNo && U.normInvoiceNo(p.invoiceNo) === normInvNo && U.norm(p.supplierGstin) === normGstin) {
      if (p.fiscalYear && fy && p.fiscalYear === fy) return true;
      if (!p.fiscalYear && p.invoiceDate && U.fiscalYear(p.invoiceDate) === fy) return true;
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
    U.norm(p.supplierGstin) === normGstin &&
    U.num(p.total) === invTotal &&
    U.daysBetween(p.invoiceDate, invDate) <= 90 &&
    U.normInvoiceNo(p.invoiceNo) !== normInvNo &&
    U.similarity(p.description, inv.description) >= 0.9
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
    if (U.norm(p.supplierGstin) !== normGstin) return false;
    if (U.daysBetween(p.invoiceDate, invDate) > 14) return false;
    const pAmt = U.num(p.total);
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
  const exactBatchMatch = (earlier || []).find(b =>
    b !== inv &&
    U.norm(b.supplierGstin) === normGstin &&
    U.normInvoiceNo(b.invoiceNo) === normInvNo &&
    U.fiscalYear(b.invoiceDate) === fy
  );

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
    U.norm(b.supplierGstin) === normGstin &&
    U.num(b.total) === invTotal &&
    U.daysBetween(b.invoiceDate, invDate) <= 90 &&
    U.normInvoiceNo(b.invoiceNo) !== normInvNo &&
    U.similarity(b.description, inv.description) >= 0.9
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

/**
 * Inserts a PASS (or cleared/posted) invoice into the HANA ledger (ap.Posted).
 */
async function insertInvoiceIntoLedger(inv, { blocked = false, user = 'reviewer' } = {}) {
  const fy = U.fiscalYear(inv.invoiceDate);
  const existing = await cds.run(
    SELECT.one.from('ap.Posted').where({
      supplierGstin: inv.supplierGstin || null,
      invoiceNo: inv.invoiceNo || null,
      fiscalYear: fy,
    })
  );

  if (existing) {
    if (existing.blocked && !blocked) {
      await cds.run(UPDATE('ap.Posted').set({ blocked: false }).where({ ID: existing.ID }));
    }
    return existing.ID;
  }

  const id = crypto.randomUUID();
  await cds.run(INSERT.into('ap.Posted').entries({
    ID: id,
    invoiceNo: inv.invoiceNo,
    supplierGstin: inv.supplierGstin,
    fiscalYear: fy,
    invoiceDate: inv.invoiceDate,
    total: inv.total !== undefined && inv.total !== null ? Number(inv.total) : 0,
    supplierName: inv.supplierName || null,
    description: inv.description || '',
    irn: inv.irn || null,
    blocked,
    recurringPo: Boolean(inv.recurringPo),
    postedAt: new Date().toISOString(),
  }));
  return id;
}

module.exports = {
  loadLedgerForInvoices,
  findDatabaseMatch,
  insertInvoiceIntoLedger,
  formatMoney,
};
