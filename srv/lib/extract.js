'use strict';
// Field extraction and confidence scoring for PDF text layers, OCR outputs, CSV, and XLSX files.
const GSTIN_G = /\b\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]\b/g;
const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

const MAX_FILE_BYTES = 10 * 1024 * 1024; // 10 MB
const LOW_CONFIDENCE_THRESHOLD = 70;     // Assumption until confirmed by client

const UNSUPPORTED_FILE_MSG =
  'Only PDF, PNG and JPG files are supported.';

const FILE_TOO_LARGE_MSG =
  'File is too large. Maximum size is 10 MB.';

const first = (text, re) => { const m = text.match(re); return m ? m[1].trim() : null; };
const money = (text, re) => { const v = first(text, re); return v === null ? undefined : Number(v.replace(/,/g, '')); };
const num = (s) => Number(String(s).replace(/,/g, ''));

function toIsoDate(s) {
  if (!s) return null;
  const t = s.trim();
  let m = t.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})$/);
  if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  m = t.match(/^(\d{1,2})\s+([A-Za-z]{3,9})\.?\s+(\d{4})$/);
  const mon = m && MONTHS[m[2].slice(0, 3).toLowerCase()];
  if (mon) return `${m[3]}-${String(mon).padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  return /^\d{4}-\d{2}-\d{2}$/.test(t) ? t : null;
}

const DATE_RE = /(?:invoice\s*date|date\s*of\s*issue|date\s*of\s*invoice|date)\s*[:\-]?\s*(\d{1,2}[\/\-.]\d{1,2}[\/\-.]\d{4}|\d{4}-\d{2}-\d{2}|\d{1,2}\s+[A-Za-z]{3,9}\.?\s+\d{4})/i;
const SUMMARY_RE = /(\d{1,2}(?:\.\d+)?)\s*%\s+([\d,]+\.\d{2})\s+([\d,]+\.\d{2})\s+([\d,]+\.\d{2})/;

function extractFields(text) {
  const t = text || '';
  const gstins = [...new Set(t.match(GSTIN_G) || [])];
  const taxIds = [...t.matchAll(/tax\s*id\s*[:\-]\s*([A-Za-z0-9\-\/]+)/gi)].map(m => m[1]);
  const isVatStyle = /\bVAT\b/i.test(t) && !/\b(CGST|SGST|IGST)\b/i.test(t);
  const sum = isVatStyle ? t.match(SUMMARY_RE) : null;
  const fields = {
    supplierName: first(t, /(?:supplier|seller|vendor)\s*(?:name)?\s*[:\-]\s*([^\n\r]+)/i),
    supplierGstin: gstins[0] || first(t, /(?:supplier|seller|vendor)\s*gstin\s*[:\-]?\s*([0-9A-Z]{15})/i),
    buyerGstin: gstins[1] || first(t, /buyer\s*gstin\s*[:\-]?\s*([0-9A-Z]{15})/i),
    buyerTaxId: taxIds.find(id => id !== gstins[0]),
    invoiceNo: first(t, /invoice\s*(?:no\.?|number|#)\s*[:\-]?\s*([A-Za-z0-9\/\-]+)/i),
    invoiceDate: toIsoDate(first(t, DATE_RE)),
    poNumber: first(t, /\bPO\s*(?:no\.?|number|#)?\s*[:\-]?\s*(\d{6,12})\b/i),
    description: first(t, /(?:description|services|items)\s*[:\-]\s*([^\n\r]{3,160})/i),
    hsn: first(t, /(?:HSN|SAC)\s*(?:code)?\s*[:\-]?\s*(\d{4,8})/i),
    taxable: sum ? num(sum[2]) : money(t, /taxable\s*(?:value|amount)?\s*[:\-]?\s*(?:INR|Rs\.?)?\s*([\d,]+\.?\d*)/i),
    vat: sum ? num(sum[3]) : undefined,
    cgst: money(t, /cgst[^\n\r]*?([\d,]+\.\d{2})/i) ?? money(t, /cgst(?:\s*\(\d+%\))?\s*[:\-]\s*(?:INR|Rs\.?)?\s*([\d,]+)/i),
    sgst: money(t, /sgst[^\n\r]*?([\d,]+\.\d{2})/i) ?? money(t, /sgst(?:\s*\(\d+%\))?\s*[:\-]\s*(?:INR|Rs\.?)?\s*([\d,]+)/i),
    igst: money(t, /igst[^\n\r]*?([\d,]+\.\d{2})/i) ?? money(t, /igst(?:\s*\(\d+%\))?\s*[:\-]\s*(?:INR|Rs\.?)?\s*([\d,]+)/i),
    total: sum ? num(sum[4])
      : (money(t, /(?:grand\s*total|total\s*amount\s*payable|amount\s*payable|gross\s*(?:worth|total|amount))\s*[:\-]?\s*(?:INR|Rs\.?)?\s*([\d,]+\.?\d*)/i)
        ?? money(t, /total\s*(?:amount|value)?\s*[:\-]?\s*(?:INR|Rs\.?)?\s*([\d,]+\.?\d*)/i)),
    ifsc: first(t, /\b([A-Z]{4}0[A-Z0-9]{6})\b/),
    accountNo: first(t, /(?:a\/c|account)\s*(?:no\.?|number)?\s*[:\-]?\s*(\d{9,18})/i),
  };
  for (const k of Object.keys(fields)) {
    if (fields[k] === undefined || fields[k] === null || fields[k] === '' || Number.isNaN(fields[k])) delete fields[k];
  }
  return fields;
}

/**
 * Validates and detects file type:
 * - Supported extensions/types: PDF (.pdf), Images (.png, .jpg, .jpeg)
 * - Enforces 10 MB maximum file size limit.
 * - Rejects Word (.docx, .doc) and any other unsupported file types.
 */
function validateAndDetectFile(fileName, fileBuffer, declaredSize, opts = {}) {
  const size = declaredSize !== undefined && declaredSize !== null ? Number(declaredSize) : (fileBuffer ? fileBuffer.length : 0);
  if (size > MAX_FILE_BYTES || (fileBuffer && fileBuffer.length > MAX_FILE_BYTES)) {
    return {
      ok: false,
      error: FILE_TOO_LARGE_MSG,
    };
  }

  const ext = String(fileName || '').toLowerCase().split('.').pop();
  const allowedExts = opts.pdfOnly ? ['pdf'] : ['pdf', 'png', 'jpg', 'jpeg'];

  if (!allowedExts.includes(ext)) {
    return {
      ok: false,
      error: UNSUPPORTED_FILE_MSG,
    };
  }

  if (!fileBuffer || fileBuffer.length < 4) {
    return { ok: false, error: 'The uploaded file is empty or corrupted.' };
  }

  const isPdfHeader = fileBuffer.subarray(0, 4).toString('latin1') === '%PDF';
  const isPngHeader = fileBuffer[0] === 0x89 && fileBuffer[1] === 0x50 && fileBuffer[2] === 0x4E && fileBuffer[3] === 0x47;
  const isJpgHeader = fileBuffer[0] === 0xFF && fileBuffer[1] === 0xD8 && fileBuffer[2] === 0xFF;

  if (ext === 'pdf' && isPdfHeader) {
    return { ok: true, kind: 'PDF', label: 'PDF', size };
  }
  if (!opts.pdfOnly && ext === 'png' && isPngHeader) {
    return { ok: true, kind: 'PNG', label: 'Image (PNG or JPG)', size };
  }
  if (!opts.pdfOnly && (ext === 'jpg' || ext === 'jpeg') && isJpgHeader) {
    return { ok: true, kind: 'JPG', label: 'Image (PNG or JPG)', size };
  }

  return {
    ok: false,
    error: UNSUPPORTED_FILE_MSG,
  };
}

/**
 * Computes field confidence map for extracted fields.
 * Any field with OCR confidence < 70% is flagged as 'Low'.
 * Fields 70%-89% are 'Check', >= 90% are 'High'.
 */
function computeFieldConfidences(fields, opts = {}) {
  const { ocrUsed = false, ocrConfidence = 95, words = [], threshold = LOW_CONFIDENCE_THRESHOLD } = opts;
  const result = {};

  for (const [key, val] of Object.entries(fields || {})) {
    if (val === undefined || val === null || val === '') continue;
    let conf = ocrUsed ? Number(ocrConfidence || 82) : 98;

    if (ocrUsed && Array.isArray(words) && words.length > 0) {
      const tokens = String(val).toLowerCase().split(/\s+/).filter(Boolean);
      const matched = words.filter(w => {
        const wt = String(w.text || '').toLowerCase().replace(/[^a-z0-9]/g, '');
        return tokens.some(t => {
          const ct = t.replace(/[^a-z0-9]/g, '');
          return ct && wt && (wt.includes(ct) || ct.includes(wt));
        });
      });
      if (matched.length > 0) {
        conf = Math.round(matched.reduce((s, w) => s + Number(w.confidence || ocrConfidence), 0) / matched.length);
      }
    }

    let label = 'High';
    if (conf < threshold) {
      label = 'Low';
    } else if (conf < 90 || ocrUsed) {
      label = 'Check';
    }

    result[key] = {
      value: val,
      confidence: conf,
      label, // 'High' | 'Check' | 'Low'
    };
  }

  return result;
}

function readPdfMeta(buf) {
  const s = buf.toString('latin1');
  const p = s.match(/\/Producer\s*\(([^)]*)\)/);
  const c = s.match(/\/Creator\s*\(([^)]*)\)/);
  return { producer: p ? p[1] : '', creator: c ? c[1] : '' };
}

module.exports = {
  extractFields,
  readPdfMeta,
  toIsoDate,
  validateAndDetectFile,
  computeFieldConfidences,
  MAX_FILE_BYTES,
  LOW_CONFIDENCE_THRESHOLD,
  UNSUPPORTED_FILE_MSG,
  FILE_TOO_LARGE_MSG,
};
