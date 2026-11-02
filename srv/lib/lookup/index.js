'use strict';
// Section 4: Lookup layer with two implementations:
//   a) Masters file (default when CLIENT_DB_LOOKUP_ENABLED is unset or "false")
//   b) Client database (read-only connection behind CLIENT_DB_LOOKUP_ENABLED="true")
//
// Logs each lookup: time, user, function name, row count. Never logs field values.

const fs = require('fs');
const path = require('path');
const U = require('../../rules/util');

const MAX_ROWS = 500;
const FORBIDDEN_SQL_VERBS = /\b(INSERT|UPDATE|DELETE|DROP|ALTER|TRUNCATE|CREATE|REPLACE|MERGE|GRANT|REVOKE|CALL|EXEC|EXECUTE)\b/i;

function logLookup(user, fnName, rowCount) {
  const ts = new Date().toISOString();
  const who = user || 'reviewer';
  console.log(`[LOOKUP_AUDIT] Time: ${ts}, User: ${who}, Function: ${fnName}, Rows: ${Number(rowCount) || 0}`);
}

function isClientDbEnabled() {
  return String(process.env.CLIENT_DB_LOOKUP_ENABLED || 'false').toLowerCase() === 'true';
}

function getClientDbConfig() {
  const host = process.env.CLIENT_DB_HOST;
  const user = process.env.CLIENT_DB_USER;
  const password = process.env.CLIENT_DB_PASSWORD;
  const url = process.env.CLIENT_DB_URL;
  if ((!host || !user || !password) && !url) {
    throw new Error('Client database is not configured');
  }
  return {
    host,
    port: Number(process.env.CLIENT_DB_PORT || 443),
    user,
    password,
    database: process.env.CLIENT_DB_NAME || '',
    url,
    readOnly: true,
  };
}

/**
 * Read-only parameterized SQL execution guard for client database lookup.
 * Rejects any non-SELECT or mutating SQL (INSERT, UPDATE, DELETE, DDL),
 * requires parameterized array, and enforces a 500-row cap.
 */
async function executeReadOnlyQuery(sql, params = [], adapter = null) {
  const trimmed = String(sql || '').trim();
  if (!trimmed) {
    throw new Error('Read-only violation: empty SQL query');
  }
  if (FORBIDDEN_SQL_VERBS.test(trimmed) || !/^SELECT\b/i.test(trimmed)) {
    throw new Error('Read-only violation: client lookup cannot run INSERT, UPDATE, DELETE, or DDL statements');
  }
  if (trimmed.includes(';') && trimmed.indexOf(';') < trimmed.length - 1) {
    throw new Error('Read-only violation: multi-statement SQL queries are forbidden');
  }
  if (!Array.isArray(params)) {
    throw new Error('Read-only violation: queries must use a parameter array');
  }

  // Verify client DB credentials before executing against remote client DB
  const cfg = getClientDbConfig();

  // Ensure LIMIT 500 is applied
  const boundedSql = /\bLIMIT\s+\d+/i.test(trimmed)
    ? trimmed
    : `${trimmed.replace(/;$/, '')} LIMIT ${MAX_ROWS}`;

  if (typeof adapter === 'function') {
    const rawRows = await adapter(boundedSql, params, cfg);
    return Array.isArray(rawRows) ? rawRows.slice(0, MAX_ROWS) : [];
  }

  // If no live client database driver/adapter is injected, throw connection error unless configured
  throw new Error('Client database connection requires approved read-only driver session');
}

function loadMasters() {
  return JSON.parse(fs.readFileSync(path.join(__dirname, '../../../data/masters.json'), 'utf8'));
}

function loadSeedPosted() {
  const csvPath = path.join(__dirname, '../../../db/data/ap-Posted.csv');
  if (!fs.existsSync(csvPath)) return [];
  const lines = fs.readFileSync(csvPath, 'utf8').trim().split('\n');
  if (lines.length < 2) return [];
  const head = lines[0].split(',');
  return lines.slice(1).map(l => {
    const cells = l.split(',');
    const row = Object.fromEntries(head.map((h, i) => [h, cells[i] === '' ? null : cells[i]]));
    row.total = Number(row.total);
    row.recurringPo = row.recurringPo === 'true';
    return row;
  });
}

/**
 * 1. findVendorByGstin(gstin, opts)
 * Returns only the fields the rules need: [{ id, name, gstin }]
 */
async function findVendorByGstin(gstin, opts = {}) {
  const user = opts.user || 'reviewer';
  if (isClientDbEnabled()) {
    const rows = await executeReadOnlyQuery(
      'SELECT id, name, gstin FROM client_vendors WHERE gstin = ? LIMIT 500',
      [U.norm(gstin)],
      opts.adapter
    );
    const projected = rows.slice(0, MAX_ROWS).map(r => ({ id: r.id, name: r.name, gstin: r.gstin }));
    logLookup(user, 'findVendorByGstin', projected.length);
    return projected;
  }

  const masters = opts.masters || loadMasters();
  const g = U.norm(gstin);
  const matching = (masters.vendors || [])
    .filter(v => g && U.norm(v.gstin) === g)
    .slice(0, MAX_ROWS)
    .map(v => ({ id: v.id, name: v.name, gstin: v.gstin }));
  logLookup(user, 'findVendorByGstin', matching.length);
  return matching;
}

/**
 * 2. findVendorBankDetails(vendorId, opts)
 * Returns only the fields the rules need: { vendorId, ifsc, account } or null
 */
async function findVendorBankDetails(vendorId, opts = {}) {
  const user = opts.user || 'reviewer';
  if (isClientDbEnabled()) {
    const rows = await executeReadOnlyQuery(
      'SELECT id, ifsc, account FROM client_vendor_banks WHERE id = ? LIMIT 500',
      [String(vendorId || '')],
      opts.adapter
    );
    const first = rows[0] ? { vendorId: rows[0].id, ifsc: rows[0].ifsc, account: rows[0].account } : null;
    logLookup(user, 'findVendorBankDetails', first ? 1 : 0);
    return first;
  }

  const masters = opts.masters || loadMasters();
  const v = (masters.vendors || []).find(x => x.id === vendorId);
  const result = v ? { vendorId: v.id, ifsc: v.ifsc, account: v.account } : null;
  logLookup(user, 'findVendorBankDetails', result ? 1 : 0);
  return result;
}

/**
 * 3. findOpenPurchaseOrders(vendorId, opts)
 * Returns only the fields the rules need: [{ po, vendorGstin, date, recurring, description }]
 */
async function findOpenPurchaseOrders(vendorId, opts = {}) {
  const user = opts.user || 'reviewer';
  if (isClientDbEnabled()) {
    const rows = await executeReadOnlyQuery(
      'SELECT po, vendor_gstin AS vendorGstin, po_date AS date, recurring, description FROM client_purchase_orders WHERE vendor_id = ? OR vendor_gstin = ? LIMIT 500',
      [String(vendorId || ''), String(vendorId || '')],
      opts.adapter
    );
    const projected = rows.slice(0, MAX_ROWS).map(p => ({
      po: p.po,
      vendorGstin: p.vendorGstin,
      date: p.date,
      recurring: Boolean(p.recurring),
      description: p.description,
    }));
    logLookup(user, 'findOpenPurchaseOrders', projected.length);
    return projected;
  }

  const masters = opts.masters || loadMasters();
  const vendor = (masters.vendors || []).find(v => v.id === vendorId || U.norm(v.gstin) === U.norm(vendorId));
  const gstin = vendor ? U.norm(vendor.gstin) : U.norm(vendorId);
  const pos = (masters.purchaseOrders || [])
    .filter(p => !gstin || U.norm(p.vendorGstin) === gstin)
    .slice(0, MAX_ROWS)
    .map(p => ({
      po: p.po,
      vendorGstin: p.vendorGstin,
      date: p.date,
      recurring: Boolean(p.recurring),
      description: p.description,
    }));
  logLookup(user, 'findOpenPurchaseOrders', pos.length);
  return pos;
}

/**
 * 4. findPostedInvoices(vendorId, financialYear, opts)
 * Returns only the fields the rules need: [{ invoiceNo, supplierGstin, invoiceDate, total, description, irn, recurringPo }]
 */
async function findPostedInvoices(vendorId, financialYear, opts = {}) {
  const user = opts.user || 'reviewer';
  if (isClientDbEnabled()) {
    const rows = await executeReadOnlyQuery(
      'SELECT invoice_no AS invoiceNo, supplier_gstin AS supplierGstin, invoice_date AS invoiceDate, total, description, irn, recurring_po AS recurringPo FROM client_posted_invoices WHERE supplier_gstin = ? AND financial_year = ? LIMIT 500',
      [String(vendorId || ''), String(financialYear || '')],
      opts.adapter
    );
    const projected = rows.slice(0, MAX_ROWS).map(r => ({
      invoiceNo: r.invoiceNo,
      supplierGstin: r.supplierGstin,
      invoiceDate: r.invoiceDate,
      total: Number(r.total),
      description: r.description || '',
      irn: r.irn || null,
      recurringPo: Boolean(r.recurringPo),
    }));
    logLookup(user, 'findPostedInvoices', projected.length);
    return projected;
  }

  const masters = opts.masters || loadMasters();
  const vendor = (masters.vendors || []).find(v => v.id === vendorId || U.norm(v.gstin) === U.norm(vendorId));
  const gstin = vendor ? U.norm(vendor.gstin) : U.norm(vendorId);
  const allPosted = opts.posted || loadSeedPosted();

  const filtered = allPosted
    .filter(p => {
      const matchVendor = !gstin || U.norm(p.supplierGstin) === gstin;
      const matchFy = !financialYear || U.fiscalYear(p.invoiceDate) === financialYear;
      return matchVendor && matchFy;
    })
    .slice(0, MAX_ROWS)
    .map(p => ({
      invoiceNo: p.invoiceNo,
      supplierGstin: p.supplierGstin,
      invoiceDate: p.invoiceDate,
      total: Number(p.total),
      description: p.description || '',
      irn: p.irn || null,
      recurringPo: Boolean(p.recurringPo),
    }));
  logLookup(user, 'findPostedInvoices', filtered.length);
  return filtered;
}

module.exports = {
  findVendorByGstin,
  findVendorBankDetails,
  findOpenPurchaseOrders,
  findPostedInvoices,
  executeReadOnlyQuery,
  isClientDbEnabled,
  getClientDbConfig,
  MAX_ROWS,
};
