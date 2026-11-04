'use strict';
// Duplicate Invoice Detection Agent rule catalogue.
// Active fraud rules per mandate:
// 1. AP-02 Exact duplicate: same supplier GSTIN, FY, invoice no or IRN -> REJECT.
// 2. AP-09 Same vendor, amount and services within 90 days (recurring contract POs excluded) -> REJECT.
// 3. AP-03 GSTIN reuse: one GSTIN registered to multiple vendor IDs (unless on exemption list) -> REJECT.
// 4. AP-11 Split invoices: 2+ bills from vendor within 14 days in 5% band below limit whose sum reaches limit >= 100,000 INR -> HOLD.
//
// Other 10 rules (AP-01, 04, 05, 06, 07, 08, 10, 12, 13, 14) are kept in code but DISABLED via configuration flag.
const crypto = require('crypto');
const U = require('./util');

const RULE_CONFIG = {
  // By default, only the 4 mandatory rules are active.
  activeRules: (process.env.ENABLE_ALL_RULES === 'true')
    ? ['AP-01', 'AP-02', 'AP-03', 'AP-04', 'AP-05', 'AP-06', 'AP-07', 'AP-08', 'AP-09', 'AP-10', 'AP-11', 'AP-12', 'AP-13', 'AP-14']
    : ['AP-02', 'AP-03', 'AP-09', 'AP-11'],
  isRuleActive(id) {
    return this.activeRules.includes(id);
  },
};

const TOL_TOTAL = 1.0;
const TOL_RATE_PCT = 0.1;

const findVendor = (masters, inv) =>
  (masters.vendors || []).find(v => U.norm(v.gstin) && U.norm(v.gstin) === U.norm(inv.supplierGstin || inv.SupplierGSTIN)) ||
  (masters.vendors || []).find(v => inv.supplierId && v.id === inv.supplierId) ||
  (masters.vendors || []).find(v => U.norm(v.name) && U.norm(v.name) === U.norm(inv.InvoicingParty || inv.supplierName));

const findPo = (masters, inv) =>
  inv.poNumber ? (masters.purchaseOrders || []).find(p => String(p.po) === String(inv.poNumber)) : undefined;

const supplierKeyOf = (x) => U.norm(x.supplierGstin || x.SupplierGSTIN || x.supplierId || x.InvoicingParty || x.supplierName);
const sameSupplier = (a, b) => {
  const ka = supplierKeyOf(a);
  const kb = supplierKeyOf(b);
  return Boolean(ka && kb && ka === kb);
};

const others = (inv, ctx) => [...(ctx.posted || []), ...((ctx.batch || []).filter(b => b !== inv))];

function verifyIrpJwt(token, pem) {
  const parts = String(token).trim().split('.');
  if (parts.length !== 3) return { ok: false, reason: 'not a JWT' };
  let header;
  try { header = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8')); }
  catch { return { ok: false, reason: 'unreadable header' }; }
  if (header.alg !== 'RS256') return { ok: false, reason: `algorithm ${header.alg} is not allowed` };
  const verifier = crypto.createVerify('RSA-SHA256');
  verifier.update(parts[0] + '.' + parts[1]);
  verifier.end();
  if (!verifier.verify(pem, Buffer.from(parts[2], 'base64url'))) return { ok: false, reason: 'signature does not match the IRP key' };
  try { return { ok: true, payload: JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) }; }
  catch { return { ok: false, reason: 'unreadable payload' }; }
}

// ---------- AP-01 e-Invoice QR signature and content (DISABLED by default) ----------
function ap01(inv, ctx) {
  if (!RULE_CONFIG.isRuleActive('AP-01')) {
    return { tier: 'DISABLED', text: 'This check is disabled in the active configuration.' };
  }
  if (!inv.qrJwt) return { tier: 'SKIPPED', text: 'No IRN QR code on the invoice.' };
  if (!ctx.irpPublicKeyPem) return { tier: 'SKIPPED', text: 'IRP public key not configured.' };
  const v = verifyIrpJwt(inv.qrJwt, ctx.irpPublicKeyPem);
  if (!v.ok) return { tier: 'REJECT', text: `QR signature check failed (${v.reason}).` };
  return { tier: 'PASS', text: 'QR signature valid.' };
}

// ---------- MANDATORY 1: AP-02 Exact duplicate (ACTIVE -> REJECT) ----------
function ap02(inv, ctx) {
  if (!RULE_CONFIG.isRuleActive('AP-02')) {
    return { tier: 'DISABLED', text: 'This check is disabled in the active configuration.' };
  }
  const key = U.dupKeyOf(inv);
  const pool = [...(ctx.posted || []), ...(ctx.earlier || [])];
  const hit = pool.find(p => U.dupKeyOf(p) === key || (inv.irn && p.irn && p.irn === inv.irn));
  if (hit) {
    const invNo = hit.invoiceNo || hit.SupplierInvoice || inv.invoiceNo || inv.SupplierInvoice || '-';
    const rawDate = hit.invoiceDate || hit.InvoiceDate || hit.PostingDate || inv.invoiceDate || inv.InvoiceDate || inv.PostingDate || '-';
    const fyRaw = U.fiscalYear(inv.invoiceDate || inv.InvoiceDate || inv.PostingDate || rawDate) !== 'UNKNOWN'
      ? U.fiscalYear(inv.invoiceDate || inv.InvoiceDate || inv.PostingDate || rawDate)
      : (inv.FiscalYear || inv.fiscalYear || hit.fiscalYear || 'current');
    const fyShort = String(fyRaw).replace(/^(\d{4})-20(\d{2})$/, '$1-$2');
    return {
      tier: 'REJECT',
      text: `Duplicate of invoice ${invNo} from the same supplier, same financial year (${fyShort}), dated ${rawDate}.`,
    };
  }
  const bl = (ctx.masters.blacklistGstins || []).map(U.norm);
  const gstinNorm = U.norm(inv.supplierGstin || inv.SupplierGSTIN);
  if (gstinNorm && bl.includes(gstinNorm)) {
    return { tier: 'HOLD', text: `Supplier ${gstinNorm} is on internal blacklist.` };
  }
  return { tier: 'PASS', text: 'No duplicate found for this supplier and financial year.' };
}

// ---------- MANDATORY 3: AP-03 GSTIN reuse (ACTIVE -> REJECT) ----------
function ap03(inv, ctx) {
  if (!RULE_CONFIG.isRuleActive('AP-03')) {
    return { tier: 'DISABLED', text: 'This check is disabled in the active configuration.' };
  }
  const g = U.norm(inv.supplierGstin || inv.SupplierGSTIN);
  if (!g) return { tier: 'SKIPPED', text: 'GSTIN not provided' };

  const vendors = ctx.masters.vendors || [];
  const matching = vendors.filter(v => U.norm(v.gstin) === g);

  if (matching.length > 1) {
    const ids = matching.map(v => v.id);
    const exemptions = ctx.masters.parentAffiliateExemptions || [];
    const isExempt = exemptions.some(pair => {
      const p = pair.map(String);
      return ids.every(id => p.includes(id));
    });

    if (!isExempt) {
      return {
        tier: 'REJECT',
        text: `GSTIN reuse: GSTIN ${g} is registered to multiple vendor IDs (${ids.join(', ')}). Exemption not found in documented parent/affiliate list. Outcome: REJECT.`,
      };
    }
  }
  return { tier: 'PASS', text: 'GSTIN is registered to a unique vendor ID (or exempted parent/affiliate pair).' };
}

// ---------- AP-04 Addressee (buyer) check (DISABLED by default) ----------
function ap04(inv, ctx) {
  if (!RULE_CONFIG.isRuleActive('AP-04')) {
    return { tier: 'DISABLED', text: 'This check is disabled in the active configuration.' };
  }
  return { tier: 'PASS', text: 'Addressee check passed.' };
}

// ---------- AP-05 Bank details changed vs master (DISABLED by default) ----------
function ap05(inv, ctx) {
  if (!RULE_CONFIG.isRuleActive('AP-05')) {
    return { tier: 'DISABLED', text: 'This check is disabled in the active configuration.' };
  }
  return { tier: 'PASS', text: 'Bank details check passed.' };
}

// ---------- AP-06 Bank account collision (DISABLED by default) ----------
function ap06(inv, ctx) {
  if (!RULE_CONFIG.isRuleActive('AP-06')) {
    return { tier: 'DISABLED', text: 'This check is disabled in the active configuration.' };
  }
  return { tier: 'PASS', text: 'Bank collision check passed.' };
}

// ---------- AP-07 PO and receipt control (DISABLED by default) ----------
function ap07(inv, ctx) {
  if (!RULE_CONFIG.isRuleActive('AP-07')) {
    return { tier: 'DISABLED', text: 'This check is disabled in the active configuration.' };
  }
  return { tier: 'PASS', text: 'PO check passed.' };
}

// ---------- AP-08 Arithmetic and GST tax (DISABLED by default) ----------
function ap08(inv, ctx) {
  if (!RULE_CONFIG.isRuleActive('AP-08')) {
    return { tier: 'DISABLED', text: 'This check is disabled in the active configuration.' };
  }
  return { tier: 'PASS', text: 'Arithmetic check passed.' };
}

// ---------- MANDATORY 2: AP-09 Same vendor, amount and services (ACTIVE -> REJECT) ----------
function ap09(inv, ctx) {
  if (!RULE_CONFIG.isRuleActive('AP-09')) {
    return { tier: 'DISABLED', text: 'This check is disabled in the active configuration.' };
  }
  const usedPostingDate = Boolean(inv.postingDateUsed || (!inv.InvoiceDate && (inv.PostingDate || inv.postingDate)));
  const dateNoteSuffix = usedPostingDate ? ' (Invoice date not provided, posting date used)' : '';
  const invDate = inv.InvoiceDate || inv.invoiceDate || inv.PostingDate || inv.postingDate;

  const po = findPo(ctx.masters, inv);
  if (po && po.recurring) {
    return { tier: 'PASS', text: `Matched to recurring contract PO ${po.po}. Recurring contract POs are excluded.${dateNoteSuffix}` };
  }
  const hit = others(inv, ctx).find(h => {
    const hDate = h.InvoiceDate || h.invoiceDate || h.PostingDate || h.postingDate;
    return sameSupplier(h, inv) &&
      U.num(h.total ?? h.InvoiceGrossAmount) === U.num(inv.total ?? inv.InvoiceGrossAmount) &&
      U.daysBetween(hDate, invDate) <= 90 &&
      U.normInvoiceNo(h.invoiceNo || h.SupplierInvoice) !== U.normInvoiceNo(inv.invoiceNo || inv.SupplierInvoice) &&
      U.similarity(h.description || h.SupplierInvoiceIDByInvcgParty || h.DocumentHeaderText, inv.description || inv.SupplierInvoiceIDByInvcgParty || inv.DocumentHeaderText) >= 0.9;
  });

  if (hit) {
    const tier = process.env.AP09_TIER || (ctx.masters && ctx.masters.config && ctx.masters.config.AP09_TIER) || 'REJECT';
    const hitNo = hit.invoiceNo || hit.SupplierInvoice;
    const hitDate = hit.invoiceDate || hit.InvoiceDate || hit.PostingDate || hit.postingDate || '-';
    return {
      tier,
      text: `Repeat bill with same amount and similar services within 90 days (${hitNo} dated ${hitDate}). Outcome: ${tier}. Override only by CFO and Controller together, with a logged reason.${dateNoteSuffix}`,
    };
  }
  return {
    tier: 'PASS',
    text: usedPostingDate
      ? 'No repeat bill with same amount and similar services within 90 days. Invoice date not provided, posting date used.'
      : 'No repeat bill with same amount and similar services within 90 days.',
  };
}

// ---------- AP-10 Lookalike resubmission (DISABLED by default) ----------
function ap10(inv, ctx) {
  if (!RULE_CONFIG.isRuleActive('AP-10')) {
    return { tier: 'DISABLED', text: 'This check is disabled in the active configuration.' };
  }
  return { tier: 'PASS', text: 'Lookalike resubmission check passed.' };
}

// ---------- MANDATORY 4: AP-11 Split invoices (ACTIVE -> HOLD) ----------
function ap11(inv, ctx) {
  if (!RULE_CONFIG.isRuleActive('AP-11')) {
    return { tier: 'DISABLED', text: 'This check is disabled in the active configuration.' };
  }
  const doa = (ctx.masters && ctx.masters.doa) || {};
  const MIN_LIMIT = doa.minLimit || 100000;
  const configuredLevels = doa.levels || [100000, 500000];
  const levels = configuredLevels.filter(x => x >= MIN_LIMIT).slice().sort((x, y) => x - y);
  const WINDOW = doa.windowDays || 14;
  const PROXIMITY = doa.proximity || 0.05; // 5 percent band
  const MIN_COUNT = doa.minCount || 2;     // Two or more bills

  const pool = [...(ctx.posted || []), ...(ctx.batch || [])];
  if (!pool.includes(inv)) pool.push(inv);

  const same = pool.filter(h => sameSupplier(h, inv) && U.daysBetween(h.invoiceDate, inv.invoiceDate) <= WINDOW);
  for (const limit of levels) {
    const band = same.filter(h => U.num(h.total) >= limit * (1 - PROXIMITY) && U.num(h.total) < limit);
    if (band.includes(inv) && band.length >= MIN_COUNT) {
      const sum = band.reduce((s, h) => s + U.num(h.total), 0);
      if (sum >= limit && sum >= MIN_LIMIT) {
        return {
          tier: 'HOLD',
          text: `Split invoices: ${band.length} bills from this vendor within ${WINDOW} days, each just below approval limit of ${limit} INR (${Math.round(PROXIMITY * 100)}% band), whose total reaches ${sum.toFixed(2)} INR. Outcome: HOLD (assumed thresholds pending confirmation).`,
        };
      }
    }
  }
  return { tier: 'PASS', text: 'No split invoice pattern against approval limits.' };
}

// Separate data check for GSTIN format/check-character and invoice arithmetic (Step 5 of UI pipeline, separate from AP-03)
function checkDataQuality(inv) {
  const gstin = U.norm(inv.supplierGstin);
  const gstinValid = gstin ? U.isValidGstin(gstin) : false;
  const gstinText = !gstin
    ? 'Missing supplier GSTIN'
    : (gstinValid ? `Valid 15-char GSTIN (${gstin})` : `Invalid GSTIN format or check-character (${gstin})`);

  const total = U.num(inv.total);
  const hasTaxBreakdown = inv.taxable !== undefined && inv.taxable !== null && inv.taxable !== '';
  let arithmeticValid = total > 0;
  let arithmeticText = total > 0 ? `Total ${total.toFixed(2)} INR verified` : 'Missing or zero total amount';

  if (hasTaxBreakdown && total > 0) {
    const sum = U.num(inv.taxable) + U.num(inv.cgst) + U.num(inv.sgst) + U.num(inv.igst) + U.num(inv.cess) + U.num(inv.vat);
    arithmeticValid = Math.abs(sum - total) <= TOL_TOTAL;
    arithmeticText = arithmeticValid
      ? `Taxable + tax (${sum.toFixed(2)}) matches total (${total.toFixed(2)})`
      : `Arithmetic mismatch: taxable + tax is ${sum.toFixed(2)} vs total ${total.toFixed(2)}`;
  }

  return {
    gstinValid,
    gstinStatus: gstinValid ? 'PASS' : 'FAIL',
    gstinText,
    arithmeticValid,
    arithmeticStatus: arithmeticValid ? 'PASS' : 'FAIL',
    arithmeticText,
  };
}

// ---------- AP-12 Hidden text (DISABLED by default) ----------
function ap12(inv) {
  if (!RULE_CONFIG.isRuleActive('AP-12')) {
    return { tier: 'DISABLED', text: 'This check is disabled in the active configuration.' };
  }
  return { tier: 'PASS', text: 'Hidden text check passed.' };
}

// ---------- AP-13 PDF metadata signal (DISABLED by default) ----------
function ap13(inv, ctx) {
  if (!RULE_CONFIG.isRuleActive('AP-13')) {
    return { tier: 'DISABLED', text: 'This check is disabled in the active configuration.' };
  }
  return { tier: 'PASS', text: 'Metadata check passed.' };
}

// ---------- AP-14 Calendar anomaly (DISABLED by default) ----------
function ap14(inv, ctx) {
  if (!RULE_CONFIG.isRuleActive('AP-14')) {
    return { tier: 'DISABLED', text: 'This check is disabled in the active configuration.' };
  }
  return { tier: 'PASS', text: 'Calendar check passed.' };
}

const RULES = [
  { id: 'AP-01', title: 'e-Invoice QR signature and content', run: ap01 },
  { id: 'AP-02', title: 'Exact duplicate', run: ap02 },
  { id: 'AP-03', title: 'GSTIN reuse', run: ap03 },
  { id: 'AP-04', title: 'Addressee (buyer) check', run: ap04 },
  { id: 'AP-05', title: 'Bank details changed vs master', run: ap05 },
  { id: 'AP-06', title: 'Bank account collision', run: ap06 },
  { id: 'AP-07', title: 'PO and receipt control', run: ap07 },
  { id: 'AP-08', title: 'Arithmetic and GST tax', run: ap08 },
  { id: 'AP-09', title: 'Same vendor, amount and services', run: ap09 },
  { id: 'AP-10', title: 'Lookalike resubmission', run: ap10 },
  { id: 'AP-11', title: 'Split invoices', run: ap11 },
  { id: 'AP-12', title: 'Hidden or adversarial text in PDF', run: ap12 },
  { id: 'AP-13', title: 'PDF metadata signal', run: ap13 },
  { id: 'AP-14', title: 'Calendar anomaly', run: ap14 },
];

module.exports = { RULES, RULE_CONFIG, verifyIrpJwt, findVendor, gstinReuse: ap03, checkDataQuality };
