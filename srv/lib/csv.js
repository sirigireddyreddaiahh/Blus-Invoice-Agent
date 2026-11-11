'use strict';
const U = require('../rules/util');

// Reads an S/4HANA / Fiori export (CSV) into raw row objects. Header names are lowercased and trimmed.
function extractCsvRawHeaders(text) {
  const s = String(text || '').replace(/^\uFEFF/, '');
  let field = '', quoted = false;
  const firstRow = [];
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quoted) {
      if (c === '"') {
        if (s[i + 1] === '"') { field += '"'; i++; }
        else quoted = false;
      } else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { firstRow.push(field.trim()); field = ''; }
    else if (c === '\n' || c === '\r') {
      firstRow.push(field.trim());
      if (firstRow.some(v => v !== '')) return firstRow;
      firstRow.length = 0;
      field = '';
      if (c === '\r' && s[i + 1] === '\n') i++;
    } else field += c;
  }
  if (field !== '' || firstRow.length) {
    firstRow.push(field.trim());
  }
  return firstRow.filter((_, idx) => firstRow.some(v => v !== ''));
}

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

// Normalizes a column header or key: case-insensitive, spaces and punctuation ignored.
function normHeaderKey(k) {
  return String(k || '').toLowerCase().replace(/[\s._()/-]+/g, '');
}

const FIORI_FIELD_DEFS = [
  {
    field: 'SupplierInvoice',
    aliases: ['invoicenumber', 'invoicedocumentno', 'supplierinvoice', 'invoiceno', 'invno'],
    required: true,
  },
  {
    field: 'InvoicingParty',
    aliases: ['invoicingparty', 'suppliername', 'supplier', 'vendor', 'suppliervendor', 'vendorname'],
    required: true,
  },
  {
    field: 'InvoiceGrossAmount',
    aliases: ['grossinvoiceamount', 'invoicegrossamount', 'totalinr', 'amount', 'total', 'totalamount', 'gross', 'sum'],
    required: true,
  },
  {
    field: 'DocumentCurrency',
    aliases: ['currency', 'documentcurrency'],
    required: false,
  },
  {
    field: 'FiscalYear',
    aliases: ['fiscalyear'],
    required: false,
  },
  {
    field: 'CompanyCode',
    aliases: ['companycode'],
    required: false,
  },
  {
    field: 'InvoiceDate',
    aliases: ['invoicedate', 'date', 'dateofinvoice'],
    required: false,
  },
  {
    field: 'PostingDate',
    aliases: ['postingdate'],
    required: false,
  },
  {
    field: 'SupplierInvoiceIDByInvcgParty',
    aliases: ['reference', 'supplierinvoiceidbyinvcgparty', 'description', 'itemdescription', 'item', 'desc', 'particulars'],
    required: false,
  },
  {
    field: 'Status',
    aliases: ['status'],
    required: false,
  },
  {
    field: 'DocumentHeaderText',
    aliases: ['documentheadertext', 'service'],
    required: false,
  },
  {
    field: 'SupplierGSTIN',
    aliases: ['gstin', 'gstno', 'suppliergstin', 'gstinno', 'gstnumber'],
    required: false,
  },
];

const FIELD_ALIASES = Object.fromEntries(FIORI_FIELD_DEFS.map(d => [d.field, d.aliases]));

function matchFioriColumns(rawHeaders = []) {
  const normSet = new Set((rawHeaders || []).map(normHeaderKey).filter(Boolean));
  const matched = [];
  const missing = [];

  for (const def of FIORI_FIELD_DEFS) {
    const isMatched = def.aliases.some(alias => normSet.has(alias));
    if (isMatched) {
      matched.push(def.field);
    } else {
      missing.push(def.field);
    }
  }

  const columnsFound = `Columns found: ${matched.length ? matched.join(', ') : 'none'} · Missing: ${missing.length ? missing.join(', ') : 'none'}`;
  return {
    matched,
    missing,
    columnsFound,
  };
}

const flag = (v) => {
  const x = String(v || '').trim().toUpperCase();
  return x === 'Y' || x === 'YES' ? true : x === 'N' || x === 'NO' ? false : undefined;
};

const amount = (v) => {
  if (v === undefined || v === null) return undefined;
  const s = String(v).replace(/^(?:INR|Rs\.?|₹)\s*/i, '').replace(/[\s,]+/g, '').trim();
  if (s === '') return undefined;
  const n = Number(s);
  return Number.isFinite(n) ? n : undefined;
};

const isoDate = (v) => {
  const s = String(v || '').trim();
  if (!s) return undefined;
  const m = s.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{4})$/);
  if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  const m8 = s.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (m8) return `${m8[1]}-${m8[2]}-${m8[3]}`;
  return s;
};

function expandNestedInvoiceRow(r) {
  if (!r || typeof r !== 'object') return r || {};
  const expanded = { ...r };

  let parsedJson = null;
  const rawJsonField = r.json_data ?? r.jsondata ?? r.jsonData;
  if (rawJsonField && typeof rawJsonField === 'string') {
    try {
      parsedJson = JSON.parse(rawJsonField.trim());
    } catch {
      try {
        parsedJson = JSON.parse(rawJsonField.replace(/[\r\n]+/g, ' ').trim());
      } catch {
        parsedJson = null;
      }
    }
  } else if (rawJsonField && typeof rawJsonField === 'object') {
    parsedJson = rawJsonField;
  } else if (r.seller || r.summary || r.date_of_issue || r.invoice_no) {
    parsedJson = r;
  }

  if (parsedJson && typeof parsedJson === 'object') {
    const seller = (parsedJson.seller && typeof parsedJson.seller === 'object') ? parsedJson.seller : {};
    const summary = (parsedJson.summary && typeof parsedJson.summary === 'object') ? parsedJson.summary : {};
    const items = Array.isArray(parsedJson.items) ? parsedJson.items : [];

    const invNo = parsedJson.invoice_no ?? parsedJson.invoiceNo ?? parsedJson.SupplierInvoice;
    const suppName = seller.name ?? parsedJson.supplier_name ?? parsedJson.supplierName ?? parsedJson.InvoicingParty;
    const suppGstin = seller.gstin ?? seller.tax_id ?? parsedJson.supplier_gstin ?? parsedJson.supplierGstin ?? parsedJson.gstin;
    const invDate = parsedJson.date_of_issue ?? parsedJson.invoice_date ?? parsedJson.invoiceDate ?? parsedJson.date;
    const grossAmt = summary.gross_worth ?? summary.total_gross_worth ?? summary.total ?? parsedJson.gross_worth ?? parsedJson.total;
    const netAmt = summary.net_worth ?? summary.total_net_worth ?? parsedJson.net_worth ?? parsedJson.taxable;
    const itemDesc = items
      .map(it => (it && it.description ? String(it.description).trim() : ''))
      .filter(Boolean)
      .join(', ');

    if (invNo !== undefined && !expanded.SupplierInvoice && !expanded.invoiceno) {
      expanded.SupplierInvoice = String(invNo).trim();
    }
    if (suppName !== undefined && !expanded.InvoicingParty && !expanded.suppliername) {
      expanded.InvoicingParty = String(suppName).trim();
    }
    if (suppGstin !== undefined && !expanded.SupplierGSTIN && !expanded.gstin) {
      expanded.SupplierGSTIN = String(suppGstin).trim();
    }
    if (invDate !== undefined && !expanded.InvoiceDate && !expanded.invoicedate) {
      expanded.InvoiceDate = String(invDate).trim();
    }
    if (grossAmt !== undefined && !expanded.InvoiceGrossAmount && !expanded.total) {
      expanded.InvoiceGrossAmount = String(grossAmt).replace(/\s+/g, ' ').trim();
    }
    if (netAmt !== undefined && !expanded.taxable) {
      expanded.taxable = String(netAmt).replace(/\s+/g, ' ').trim();
    }
    if (itemDesc && !expanded.SupplierInvoiceIDByInvcgParty && !expanded.description) {
      expanded.SupplierInvoiceIDByInvcgParty = itemDesc;
    }
    if (!expanded.DocumentCurrency && !expanded.currency) {
      expanded.DocumentCurrency = 'INR';
    }
  }

  const rawOcr = r.ocred_text ?? r.ocredtext ?? r.ocr_text;
  if (rawOcr && typeof rawOcr === 'string' && (!expanded.SupplierInvoice || !expanded.InvoicingParty || !expanded.InvoiceGrossAmount)) {
    const t = rawOcr;
    if (!expanded.SupplierInvoice) {
      const mInv = t.match(/invoice\s*(?:no\.?|number|#)\s*[:\-]?\s*([A-Za-z0-9\/\-]+)/i);
      if (mInv) expanded.SupplierInvoice = mInv[1].trim();
    }
    if (!expanded.InvoiceDate) {
      const mDate = t.match(/(?:invoice\s*date|date\s*of\s*issue|date\s*of\s*invoice|date)\s*[:\-]?\s*(\d{1,2}[\/\-.]\d{1,2}[\/\-.]\d{4}|\d{4}-\d{2}-\d{2})/i);
      if (mDate) expanded.InvoiceDate = mDate[1].trim();
    }
    if (!expanded.SupplierGSTIN) {
      const mGstin = t.match(/\b(\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z])\b/);
      if (mGstin) expanded.SupplierGSTIN = mGstin[1].trim();
    }
    if (!expanded.InvoiceGrossAmount) {
      const mTotal = t.match(/Total\s+INR\s+[\d,]+\.\d{2}\s+INR\s+([\d,]+\.\d{2})/i) || t.match(/gross\s*worth[^\d]*([\d,]+\.\d{2})/i);
      if (mTotal) expanded.InvoiceGrossAmount = mTotal[1].trim();
    }
  }

  return expanded;
}

function pickField(normRow, aliases) {
  for (const a of aliases) {
    if (normRow[a] !== undefined && normRow[a] !== null && String(normRow[a]).trim() !== '') {
      return normRow[a];
    }
  }
  return undefined;
}

function deriveFiscalYear(dateIso) {
  if (!dateIso) return undefined;
  const fy = U.fiscalYear(dateIso);
  if (fy && fy !== 'UNKNOWN') return fy;
  const yearMatch = String(dateIso).match(/\b(20\d{2}|19\d{2})\b/);
  return yearMatch ? yearMatch[1] : undefined;
}

function s4RowToInvoice(r, index = 0) {
  const expandedRow = expandNestedInvoiceRow(r);
  const normRow = {};
  for (const [k, v] of Object.entries(expandedRow || {})) {
    const nk = normHeaderKey(k);
    if (v !== undefined && v !== null && String(v).trim() !== '' && normRow[nk] === undefined) {
      normRow[nk] = v;
    }
  }

  const category = String(normRow.category || 'services').toLowerCase();
  const received = flag(normRow.receiptdone);

  const rawSupplierInvoice = pickField(normRow, FIELD_ALIASES.SupplierInvoice);
  const rawInvoicingParty = pickField(normRow, FIELD_ALIASES.InvoicingParty);
  const rawGrossAmount = pickField(normRow, FIELD_ALIASES.InvoiceGrossAmount);
  const rawCurrency = pickField(normRow, FIELD_ALIASES.DocumentCurrency);
  const rawFiscalYear = pickField(normRow, FIELD_ALIASES.FiscalYear);
  const rawCompanyCode = pickField(normRow, FIELD_ALIASES.CompanyCode);
  const rawInvoiceDate = pickField(normRow, FIELD_ALIASES.InvoiceDate);
  const rawPostingDate = pickField(normRow, FIELD_ALIASES.PostingDate);
  const rawReference = pickField(normRow, FIELD_ALIASES.SupplierInvoiceIDByInvcgParty);
  const rawStatus = pickField(normRow, FIELD_ALIASES.Status);
  const rawHeaderText = pickField(normRow, FIELD_ALIASES.DocumentHeaderText);
  const rawGstin = pickField(normRow, FIELD_ALIASES.SupplierGSTIN);

  const SupplierInvoice = rawSupplierInvoice !== undefined ? String(rawSupplierInvoice).trim() : undefined;
  const InvoicingParty = rawInvoicingParty !== undefined ? String(rawInvoicingParty).trim() : undefined;
  const InvoiceGrossAmount = amount(rawGrossAmount);
  const DocumentCurrency = rawCurrency !== undefined && String(rawCurrency).trim() !== ''
    ? String(rawCurrency).trim().toUpperCase()
    : 'INR';

  const InvoiceDate = rawInvoiceDate !== undefined ? isoDate(rawInvoiceDate) : undefined;
  const PostingDate = rawPostingDate !== undefined ? isoDate(rawPostingDate) : undefined;
  const effectiveDate = InvoiceDate || PostingDate;

  let FiscalYear = rawFiscalYear !== undefined && String(rawFiscalYear).trim() !== ''
    ? String(rawFiscalYear).trim()
    : undefined;
  if (!FiscalYear && (PostingDate || InvoiceDate)) {
    FiscalYear = deriveFiscalYear(PostingDate || InvoiceDate);
  }

  const CompanyCode = rawCompanyCode !== undefined ? String(rawCompanyCode).trim() : undefined;
  const SupplierInvoiceIDByInvcgParty = rawReference !== undefined ? String(rawReference).trim() : undefined;
  const Status = rawStatus !== undefined ? String(rawStatus).trim() : undefined;
  const DocumentHeaderText = rawHeaderText !== undefined ? String(rawHeaderText).trim() : undefined;
  const SupplierGSTIN = rawGstin !== undefined && String(rawGstin).trim() !== ''
    ? String(rawGstin).trim().toUpperCase()
    : undefined;

  const effectiveDescription = SupplierInvoiceIDByInvcgParty || DocumentHeaderText;
  const rowFileName = normRow.filename ? String(normRow.filename).trim() : undefined;

  const inv = {
    id: normRow.id || `IMP-${String(index + 1).padStart(3, '0')}`,
    source: 'S4',
    fileName: rowFileName,
    // Internal Fiori mapped fields
    SupplierInvoice,
    InvoicingParty,
    InvoiceGrossAmount,
    DocumentCurrency,
    FiscalYear,
    CompanyCode,
    InvoiceDate,
    PostingDate,
    SupplierInvoiceIDByInvcgParty,
    Status,
    DocumentHeaderText,
    SupplierGSTIN,
    // Normalized internal aliases for rule engine, ledger, pagination & exports
    supplierId: normRow.supplierid || normRow.vendorid,
    supplierName: InvoicingParty,
    supplierGstin: SupplierGSTIN,
    buyerGstin: normRow.buyergstin ? String(normRow.buyergstin).toUpperCase() : undefined,
    invoiceNo: SupplierInvoice,
    invoiceDate: effectiveDate,
    postingDate: PostingDate,
    fiscalYear: FiscalYear,
    companyCode: CompanyCode,
    currency: DocumentCurrency,
    poNumber: normRow.ponumber || undefined,
    category,
    description: effectiveDescription,
    hsn: normRow.hsn || undefined,
    taxable: amount(normRow.taxable),
    cgst: amount(normRow.cgst),
    sgst: amount(normRow.sgst),
    igst: amount(normRow.igst),
    cess: amount(normRow.cess),
    total: InvoiceGrossAmount,
    ifsc: normRow.ifsc || normRow.ifsccode ? String(normRow.ifsc || normRow.ifsccode).toUpperCase() : undefined,
    accountNo: normRow.accountno || normRow.accountnumber || undefined,
    postingDateUsed: (!InvoiceDate && PostingDate) ? true : undefined,
    gstinNotProvided: !SupplierGSTIN ? true : undefined,
  };

  if (received !== undefined) {
    if (category === 'goods') inv.grDone = received; else inv.sesDone = received;
  }
  for (const k of Object.keys(inv)) {
    if (inv[k] === undefined || inv[k] === '') delete inv[k];
  }
  return inv;
}

function validateRequiredFields(inv, rowNumber = 1) {
  const missing = [];
  if (!inv || !inv.SupplierInvoice) missing.push('SupplierInvoice');
  if (!inv || !inv.InvoicingParty) missing.push('InvoicingParty');
  if (!inv || inv.InvoiceGrossAmount === undefined || inv.InvoiceGrossAmount === null || Number.isNaN(Number(inv.InvoiceGrossAmount))) {
    missing.push('InvoiceGrossAmount');
  }
  if (missing.length > 0) {
    const invLabel = (inv && inv.SupplierInvoice) ? `Row ${rowNumber} (${inv.SupplierInvoice})` : `Row ${rowNumber}`;
    return {
      valid: false,
      row: rowNumber,
      invoiceNo: invLabel,
      missingFields: missing,
      reason: `Row ${rowNumber} rejected: missing required field(s): ${missing.join(', ')}.`,
    };
  }
  return { valid: true, row: rowNumber, missingFields: [] };
}

function parseAndValidateS4Input(text) {
  const cleaned = String(text || '').replace(/^\uFEFF/, '').trim();
  if (!cleaned) {
    return {
      invoices: [],
      rowErrors: [],
      totalRawRows: 0,
      matchedColumns: [],
      missingColumns: FIORI_FIELD_DEFS.map(d => d.field),
      columnsFound: `Columns found: none · Missing: ${FIORI_FIELD_DEFS.map(d => d.field).join(', ')}`,
    };
  }

  let rawRows = [];
  let rawHeaders = [];
  try {
    if (cleaned.startsWith('[')) {
      rawRows = JSON.parse(cleaned);
      if (Array.isArray(rawRows) && rawRows.length > 0) {
        const keySet = new Set();
        rawRows.forEach(r => {
          if (r && typeof r === 'object') {
            Object.keys(r).forEach(k => keySet.add(k));
          }
        });
        rawHeaders = Array.from(keySet);
      }
    } else {
      rawHeaders = extractCsvRawHeaders(cleaned);
      rawRows = parseCsv(cleaned);
    }
  } catch (err) {
    return {
      parseError: err.message,
      invoices: [],
      rowErrors: [],
      totalRawRows: 0,
      matchedColumns: [],
      missingColumns: FIORI_FIELD_DEFS.map(d => d.field),
      columnsFound: '',
    };
  }

  // If rows contain nested json_data / ocred_text / seller / summary, include expanded keys in header matching
  const effectiveHeaderSet = new Set(rawHeaders);
  if (Array.isArray(rawRows) && rawRows.length > 0) {
    const sampleExpanded = expandNestedInvoiceRow(rawRows[0]);
    Object.keys(sampleExpanded || {}).forEach(k => {
      if (sampleExpanded[k] !== undefined && sampleExpanded[k] !== '') {
        effectiveHeaderSet.add(k);
      }
    });
  }

  const colMatch = matchFioriColumns(Array.from(effectiveHeaderSet));
  const invoices = [];
  const rowErrors = [];

  for (let i = 0; i < rawRows.length; i++) {
    const rowNum = i + 1;
    const inv = s4RowToInvoice(rawRows[i], i);
    const v = validateRequiredFields(inv, rowNum);
    if (!v.valid) {
      rowErrors.push({
        row: rowNum,
        invoiceNo: v.invoiceNo,
        missingFields: v.missingFields,
        reason: v.reason,
      });
    } else {
      invoices.push(inv);
    }
  }

  return {
    invoices,
    rowErrors,
    totalRawRows: rawRows.length,
    matchedColumns: colMatch.matched,
    missingColumns: colMatch.missing,
    columnsFound: colMatch.columnsFound,
  };
}

module.exports = {
  parseCsv,
  s4RowToInvoice,
  normHeaderKey,
  FIORI_FIELD_DEFS,
  matchFioriColumns,
  validateRequiredFields,
  parseAndValidateS4Input,
};

