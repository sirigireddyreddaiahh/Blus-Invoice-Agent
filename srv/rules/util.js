'use strict';
const crypto = require('crypto');

const GSTIN_CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const GSTIN_RE = /^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;
const IFSC_RE = /^[A-Z]{4}0[A-Z0-9]{6}$/;

// GSTIN check character: weighted base-36 sum over the first 14 characters.
function gstinCheckChar(first14) {
  let sum = 0;
  for (let i = 0; i < 14; i++) {
    const v = GSTIN_CHARS.indexOf(first14[i]);
    if (v < 0) return null;
    const prod = v * (i % 2 === 0 ? 1 : 2);
    sum += Math.floor(prod / 36) + (prod % 36);
  }
  return GSTIN_CHARS[(36 - (sum % 36)) % 36];
}

function isValidGstin(g) {
  return typeof g === 'string' && GSTIN_RE.test(g) && gstinCheckChar(g.slice(0, 14)) === g[14];
}

const norm = (s) => String(s ?? '').trim().toUpperCase();
const normAcct = (s) => String(s ?? '').replace(/\D/g, '');
const normInvoiceNo = (s) => String(s ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/^0+(?=.)/, '');

function levenshtein(a, b) {
  const m = a.length, n = b.length;
  if (!m) return n;
  if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[n];
}

// 0..1 similarity, 1 = identical (case-insensitive)
function similarity(a, b) {
  const A = String(a ?? '').toLowerCase().trim();
  const B = String(b ?? '').toLowerCase().trim();
  if (!A && !B) return 1;
  return 1 - levenshtein(A, B) / Math.max(A.length, B.length, 1);
}

// Indian financial year (April to March): 2026-10-30 -> "2026-27"
function fiscalYear(isoDate) {
  if (!isoDate || typeof isoDate !== 'string' || !isoDate.includes('-')) return 'UNKNOWN';
  const [y, m] = isoDate.split('-').map(Number);
  const start = m >= 4 ? y : y - 1;
  return `${start}-${String((start + 1) % 100).padStart(2, '0')}`;
}

const dayMs = 86400000;
const toMs = (iso) => Date.parse(iso + 'T00:00:00Z');
const daysBetween = (a, b) => {
  if (!a || !b) return 9999;
  return Math.abs(toMs(a) - toMs(b)) / dayMs;
};
const isSunday = (iso) => (iso ? new Date(toMs(iso)).getUTCDay() === 0 : false);
const stateOf = (gstin) => (gstin && gstin.length >= 2 ? gstin.slice(0, 2) : null);
const num = (v) => (v === undefined || v === null || v === '' ? 0 : Number(v));

function dupKeyOf(inv) {
  return `${norm(inv.supplierGstin) || norm(inv.supplierId)}|${fiscalYear(inv.invoiceDate)}|${normInvoiceNo(inv.invoiceNo)}`;
}

function auditHash(idx, ts, checkId, action, detail, prevHash) {
  return crypto.createHash('sha256')
    .update([idx, ts, checkId || '', action, detail || '', prevHash || ''].join('|'))
    .digest('hex');
}

module.exports = {
  gstinCheckChar, isValidGstin, GSTIN_RE, IFSC_RE, norm, normAcct, normInvoiceNo,
  levenshtein, similarity, fiscalYear, daysBetween, isSunday, stateOf, num, dupKeyOf, auditHash,
};
