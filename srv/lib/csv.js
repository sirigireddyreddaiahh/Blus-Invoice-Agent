'use strict';
// Reads an S/4HANA export (CSV) into invoice objects. Header names are case-insensitive.
function parseCsv(text) {
  const s = String(text).replace(/^\uFEFF/, '');
  const rows = [];
  let row = [], field = '', quoted = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quoted) {
      if (c === '"') { if (s[i + 1] === '"') { field += '"'; i++; } else quoted = false; }
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && s[i + 1] === '\n') i++;
      row.push(field); rows.push(row); row = []; field = '';
    } else field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  const data = rows.filter(r => r.some(v => v.trim() !== ''));
  if (!data.length) return [];
  const keys = data[0].map(h => h.trim().toLowerCase());
  return data.slice(1).map(r => Object.fromEntries(keys.map((k, i) => [k, (r[i] || '').trim()])));
}

const flag = (v) => {
  const x = String(v || '').trim().toUpperCase();
  return x === 'Y' || x === 'YES' ? true : x === 'N' || x === 'NO' ? false : undefined;
};
const amount = (v) => {
  const s = String(v || '').replace(/,/g, '').trim();
  if (s === '') return undefined;
  const n = Number(s);
  return Number.isFinite(n) ? n : undefined;
};
const isoDate = (v) => {
  const s = String(v || '').trim();
  const m = s.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{4})$/);
  return m ? `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}` : s;
};

function s4RowToInvoice(r, index) {
  const category = (r.category || 'services').toLowerCase();
  const received = flag(r.receiptdone || r['receipt done']);

  const invoiceNo = r.invoiceno || r['invoice no'] || r['invoice_no'] || r['invoice number'] || r.invoicenumber || r['inv no'] || r.invno;
  const supplierName = r.suppliername || r['supplier name'] || r.supplier || r.vendor || r['supplier/vendor'] || r['vendor name'];
  const supplierGstin = r.suppliergstin || r['supplier gstin'] || r.gstin || r['gst no'] || r['gstin no'] || r['gst number'];
  const invoiceDate = r.invoicedate || r['invoice date'] || r.date || r['date of invoice'] || r['invoice_date'];
  const totalVal = r.total || r.amount || r['total (inr)'] || r['total amount'] || r.sum || r.gross;
  const description = r.description || r['item description'] || r.item || r.desc || r.particulars || r.service;

  const inv = {
    id: r.id || `IMP-${String(index + 1).padStart(3, '0')}`,
    source: 'S4',
    supplierId: r.supplierid || r['supplier id'] || r.vendorid || r['vendor id'],
    supplierName: supplierName ? String(supplierName).trim() : undefined,
    supplierGstin: supplierGstin ? String(supplierGstin).trim().toUpperCase() : undefined,
    buyerGstin: (r.buyergstin || r['buyer gstin'] || '') ? String(r.buyergstin || r['buyer gstin']).toUpperCase() : undefined,
    invoiceNo: invoiceNo ? String(invoiceNo).trim() : undefined,
    invoiceDate: invoiceDate ? isoDate(invoiceDate) : undefined,
    poNumber: r.ponumber || r['po number'] || undefined,
    category,
    description: description ? String(description).trim() : undefined,
    hsn: r.hsn || undefined,
    taxable: amount(r.taxable), cgst: amount(r.cgst), sgst: amount(r.sgst),
    igst: amount(r.igst), cess: amount(r.cess), total: amount(totalVal),
    ifsc: (r.ifsc || r['ifsc code']) ? String(r.ifsc || r['ifsc code']).toUpperCase() : undefined,
    accountNo: r.accountno || r['account no'] || r['account number'] || undefined,
  };
  if (received !== undefined) {
    if (category === 'goods') inv.grDone = received; else inv.sesDone = received;
  }
  for (const k of Object.keys(inv)) if (inv[k] === undefined || inv[k] === '') delete inv[k];
  return inv;
}

module.exports = { parseCsv, s4RowToInvoice };
