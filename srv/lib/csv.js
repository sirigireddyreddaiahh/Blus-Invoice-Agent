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
  const received = flag(r.receiptdone);
  const inv = {
    id: r.id || `IMP-${String(index + 1).padStart(3, '0')}`,
    source: 'S4',
    supplierId: r.supplierid,
    supplierName: r.suppliername,
    supplierGstin: r.suppliergstin ? r.suppliergstin.toUpperCase() : undefined,
    buyerGstin: r.buyergstin ? r.buyergstin.toUpperCase() : undefined,
    invoiceNo: r.invoiceno,
    invoiceDate: r.invoicedate ? isoDate(r.invoicedate) : undefined,
    poNumber: r.ponumber || undefined,
    category,
    description: r.description,
    hsn: r.hsn || undefined,
    taxable: amount(r.taxable), cgst: amount(r.cgst), sgst: amount(r.sgst),
    igst: amount(r.igst), cess: amount(r.cess), total: amount(r.total),
    ifsc: r.ifsc ? r.ifsc.toUpperCase() : undefined,
    accountNo: r.accountno || undefined,
  };
  if (received !== undefined) {
    if (category === 'goods') inv.grDone = received; else inv.sesDone = received;
  }
  for (const k of Object.keys(inv)) if (inv[k] === undefined || inv[k] === '') delete inv[k];
  return inv;
}

module.exports = { parseCsv, s4RowToInvoice };
