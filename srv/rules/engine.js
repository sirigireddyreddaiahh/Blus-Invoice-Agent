'use strict';
const { RULES } = require('./rules');

const REQUIRED = ['invoiceNo', 'total'];

// Overall status: REJECT beats HOLD beats FLAG beats PASS. SKIPPED and DISABLED do not count.
function overall(results) {
  const tiers = results.map(r => r.tier);
  if (tiers.includes('REJECT')) return 'REJECT';
  if (tiers.includes('HOLD')) return 'HOLD';
  if (tiers.includes('FLAG')) return 'FLAG';
  return 'PASS';
}

function normalizeInvFields(inv) {
  if (!inv || typeof inv !== 'object') return inv;
  if (!inv.invoiceNo && inv.SupplierInvoice) inv.invoiceNo = inv.SupplierInvoice;
  if (!inv.SupplierInvoice && inv.invoiceNo) inv.SupplierInvoice = inv.invoiceNo;
  if (!inv.supplierName && inv.InvoicingParty) inv.supplierName = inv.InvoicingParty;
  if (!inv.InvoicingParty && inv.supplierName) inv.InvoicingParty = inv.supplierName;
  if ((inv.total === undefined || inv.total === null || inv.total === '') && inv.InvoiceGrossAmount !== undefined) {
    inv.total = Number(inv.InvoiceGrossAmount);
  }
  if (inv.InvoiceGrossAmount === undefined && inv.total !== undefined && inv.total !== null && inv.total !== '') {
    inv.InvoiceGrossAmount = Number(inv.total);
  }
  if (!inv.invoiceDate && (inv.InvoiceDate || inv.PostingDate || inv.postingDate)) {
    if (!inv.InvoiceDate && (inv.PostingDate || inv.postingDate)) {
      inv.postingDateUsed = true;
    }
    inv.invoiceDate = inv.InvoiceDate || inv.PostingDate || inv.postingDate;
  }
  if (!inv.supplierGstin && inv.SupplierGSTIN) inv.supplierGstin = inv.SupplierGSTIN;
  if (!inv.SupplierGSTIN && inv.supplierGstin) inv.SupplierGSTIN = inv.supplierGstin;
  if (!inv.description && (inv.SupplierInvoiceIDByInvcgParty || inv.DocumentHeaderText)) {
    inv.description = inv.SupplierInvoiceIDByInvcgParty || inv.DocumentHeaderText;
  }
  return inv;
}

function runRules(inv, ctx) {
  normalizeInvFields(inv);
  const hasAnyData = Boolean(
    inv.invoiceNo ||
    inv.supplierName ||
    inv.supplierGstin ||
    (inv.total !== undefined && inv.total !== null && inv.total !== '' && !Number.isNaN(Number(inv.total)))
  );
  if (!hasAnyData) {
    return {
      status: 'REJECT',
      verdict: 'Blocked',
      explanation: 'This invoice has no data',
      results: [{
        id: 'INPUT',
        title: 'Invoice data check',
        tier: 'REJECT',
        text: 'This invoice has no data',
      }],
      activeResults: [{
        id: 'INPUT',
        title: 'Invoice data check',
        tier: 'REJECT',
        text: 'This invoice has no data',
      }],
    };
  }
  const missing = REQUIRED.filter(k => inv[k] === undefined || inv[k] === null || inv[k] === '');
  if (missing.length) {
    return {
      status: 'HOLD',
      results: [{
        id: 'INPUT',
        title: 'Input completeness',
        tier: 'HOLD',
        text: `Missing required fields: ${missing.join(', ')}. Complete the invoice before checking.`,
      }],
    };
  }
  const results = RULES.map(rule => {
    try {
      const out = rule.run(inv, ctx);
      return { id: rule.id, title: rule.title, tier: out.tier, text: out.text };
    } catch (e) {
      return { id: rule.id, title: rule.title, tier: 'HOLD', text: `This check could not run (${e.message}). Review manually.` };
    }
  });
  const gstinMissing = !inv.supplierGstin && !inv.SupplierGSTIN;
  const postingDateUsed = Boolean(inv.postingDateUsed || (!inv.InvoiceDate && (inv.PostingDate || inv.postingDate)));
  const rowNotes = [];
  if (postingDateUsed) rowNotes.push('Invoice date not provided, posting date used');
  if (gstinMissing) rowNotes.push('GSTIN not provided');

  return {
    status: overall(results),
    results,
    ...(rowNotes.length ? { note: rowNotes.join(' · '), rowNotes } : {}),
  };
}

module.exports = { runRules, overall };

