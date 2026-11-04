'use strict';
const fs = require('fs');
const path = require('path');

let lastEnvMtime = 0;
let lastDefaultEnvMtime = 0;

function syncSapEnvFromDisk(forceInitial = false) {
  try {
    const envPath = path.resolve(__dirname, '../../.env');
    if (fs.existsSync(envPath)) {
      const stat = fs.statSync(envPath);
      if (forceInitial || stat.mtimeMs > lastEnvMtime) {
        lastEnvMtime = stat.mtimeMs;
        const lines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/);
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || trimmed.startsWith('#')) continue;
          const eqIdx = trimmed.indexOf('=');
          if (eqIdx > 0) {
            const key = trimmed.slice(0, eqIdx).trim();
            const val = trimmed.slice(eqIdx + 1).trim().replace(/^['"]|['"]$/g, '');
            if (forceInitial ? process.env[key] === undefined : Boolean(val)) {
              process.env[key] = val;
            }
          }
        }
      }
    }
  } catch (_e) {
    // Ignore .env read errors
  }

  try {
    const defEnvPath = path.resolve(__dirname, '../../default-env.json');
    if (fs.existsSync(defEnvPath)) {
      const stat = fs.statSync(defEnvPath);
      if (forceInitial || stat.mtimeMs > lastDefaultEnvMtime) {
        lastDefaultEnvMtime = stat.mtimeMs;
        const parsed = JSON.parse(fs.readFileSync(defEnvPath, 'utf8'));
        const envObj = (parsed && parsed.env && typeof parsed.env === 'object') ? parsed.env : parsed;
        if (envObj && typeof envObj === 'object') {
          for (const [k, v] of Object.entries(envObj)) {
            if (typeof v === 'string' && (forceInitial ? process.env[k] === undefined : Boolean(v))) {
              process.env[k] = v.trim();
            }
          }
        }
      }
    }
  } catch (_e) {
    // Ignore default-env.json read errors
  }
}

// Load .env / default-env.json once on module initialization if present
syncSapEnvFromDisk(true);

const DEFAULT_SAP_API_URL =
  'https://sandbox.api.sap.com/s4hanacloud/sap/opu/odata/sap/API_SUPPLIERINVOICE_PROCESS_SRV';

const SAP_SOURCE_LABEL = 'SAP sandbox (demo data)';

const SAP_FIELDS = [
  'SupplierInvoice',
  'FiscalYear',
  'CompanyCode',
  'InvoicingParty',
  'InvoiceGrossAmount',
  'DocumentCurrency',
  'InvoiceDate',
  'PostingDate',
  'SupplierInvoiceIDByInvcgParty',
];

function formatODataDate(val) {
  if (val === undefined || val === null || val === '') return '';
  const s = String(val).trim();
  // OData V2 date format: /Date(1492041600000)/ or /Date(1492041600000+0000)/
  const m = s.match(/\/Date\((-?\d+)(?:[+-]\d+)?\)\//);
  if (m) {
    const ms = Number(m[1]);
    if (Number.isFinite(ms)) {
      return new Date(ms).toISOString().slice(0, 10);
    }
  }
  if (/^\d{4}-\d{2}-\d{2}T/.test(s)) {
    return s.slice(0, 10);
  }
  return s;
}

/**
 * Maps a raw SAP OData V2 SupplierInvoice entry using only fields that exist in the response.
 * If a field is missing or null, leaves it empty and lists it in missingFields.
 */
function mapSapInvoiceRecord(raw = {}) {
  const mapped = {};
  const missingFields = [];

  for (const field of SAP_FIELDS) {
    const exists =
      raw !== null &&
      typeof raw === 'object' &&
      Object.prototype.hasOwnProperty.call(raw, field) &&
      raw[field] !== undefined &&
      raw[field] !== null &&
      String(raw[field]).trim() !== '';

    if (exists) {
      if (field === 'InvoiceDate' || field === 'PostingDate') {
        mapped[field] = formatODataDate(raw[field]);
      } else {
        mapped[field] = String(raw[field]).trim();
      }
    } else {
      mapped[field] = '';
      missingFields.push(field);
    }
  }

  mapped.missingFields = missingFields;
  mapped.note = missingFields.length > 0
    ? `Missing fields: ${missingFields.join(', ')}`
    : 'All fields present';
  mapped.sourceLabel = SAP_SOURCE_LABEL;

  return mapped;
}

/**
 * Converts a mapped SAP invoice record into a standard internal invoice object
 * so it can be run through the batch check pipeline while preserving SAP metadata.
 */
function sapRecordToCheckInvoice(mapped, index = 0) {
  const gross = mapped.InvoiceGrossAmount !== '' ? Number(mapped.InvoiceGrossAmount) : 0;
  const invNo = mapped.SupplierInvoiceIDByInvcgParty || mapped.SupplierInvoice || `SAP-${index + 1}`;
  const party = mapped.InvoicingParty || 'SAP Sandbox Vendor';
  const dateStr = mapped.InvoiceDate || mapped.PostingDate || new Date().toISOString().slice(0, 10);

  return {
    id: mapped.SupplierInvoice ? `${mapped.SupplierInvoice}-${mapped.FiscalYear || ''}`.replace(/-$/, '') : `SAP-${index + 1}`,
    fileName: SAP_SOURCE_LABEL,
    source: 'S4',
    sourceLabel: SAP_SOURCE_LABEL,
    supplierId: mapped.InvoicingParty || undefined,
    supplierName: mapped.InvoicingParty ? `SAP Party ${mapped.InvoicingParty}` : party,
    supplierGstin: mapped.InvoicingParty || '27AABCT0001A1Z1',
    invoiceNo: invNo,
    invoiceDate: dateStr,
    total: Number.isFinite(gross) ? gross : 0,
    currency: mapped.DocumentCurrency || 'INR',
    companyCode: mapped.CompanyCode || '',
    fiscalYear: mapped.FiscalYear || '',
    description: mapped.note && mapped.missingFields && mapped.missingFields.length > 0
      ? `${SAP_SOURCE_LABEL} (${mapped.note})`
      : SAP_SOURCE_LABEL,
    sapFields: mapped,
  };
}

function getSapConfig() {
  syncSapEnvFromDisk(false);
  const rawUrl = (process.env.SAP_API_URL || DEFAULT_SAP_API_URL).trim();
  const rawKey = (
    process.env.SAP_API_KEY ||
    process.env.SAP_SANDBOX_API_KEY ||
    ''
  ).trim();
  const isConfigured = Boolean(rawKey && rawKey !== 'your_sap_api_key_here');

  // Strip any accidental query string (e.g. ?$top=5 copied from Postman) and trailing slashes
  const cleanUrlWithoutQuery = rawUrl.split('?')[0].replace(/\/+$/, '');
  const baseUrl = cleanUrlWithoutQuery.endsWith('/A_SupplierInvoice')
    ? cleanUrlWithoutQuery.slice(0, -'/A_SupplierInvoice'.length)
    : cleanUrlWithoutQuery;
  const listUrl = `${baseUrl}/A_SupplierInvoice`;

  return {
    baseUrl,
    listUrl,
    apiKey: isConfigured ? rawKey : '',
    isConfigured,
  };
}

/**
 * Core read-only GET function used by:
 * 1. "Test SAP connection" ($top=5)
 * 2. "Fetch from SAP now" ($top=top)
 * 3. "SAP match" column lookup by invoice reference ($top=5, $filter on SupplierInvoiceIDByInvcgParty or SupplierInvoice)
 *
 * Uses GET only, 5-second timeout, sends APIKey in header server-side only,
 * and reads OData V2 body.d.results (or body.value).
 */
async function querySapSandboxInvoices({ top = 5, filter = '', reference = '', timeoutMs = 5000 } = {}) {
  const { listUrl, apiKey, isConfigured } = getSapConfig();

  if (!isConfigured) {
    return {
      ok: false,
      configured: false,
      status: 'Live SAP not configured',
      message: 'Live SAP not configured',
      reason: 'SAP_API_KEY is not set in the server environment (.env or BTP environment variables).',
      sourceLabel: SAP_SOURCE_LABEL,
      invoices: [],
      checkInvoices: [],
    };
  }

  const limit = Math.max(1, Math.min(200, Number(top) || 5));
  const queryParts = [`$top=${encodeURIComponent(String(limit))}`];

  let activeFilter = String(filter || '').trim();
  if (!activeFilter && reference) {
    const cleanRef = String(reference).trim().replace(/'/g, "''");
    if (cleanRef) {
      activeFilter = `SupplierInvoiceIDByInvcgParty eq '${cleanRef}' or SupplierInvoice eq '${cleanRef}'`;
    }
  }
  if (activeFilter) {
    queryParts.push(`$filter=${encodeURIComponent(activeFilter)}`);
  }

  const requestUrl = `${listUrl}?${queryParts.join('&')}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(requestUrl, {
      method: 'GET',
      headers: {
        APIKey: apiKey,
        Accept: 'application/json',
      },
      signal: controller.signal,
    });

    if (!res.ok) {
      return {
        ok: false,
        configured: true,
        status: 'SAP unavailable',
        message: 'SAP unavailable',
        reason: `SAP API returned HTTP ${res.status}`,
        httpStatus: res.status,
        sourceLabel: SAP_SOURCE_LABEL,
        invoices: [],
        checkInvoices: [],
      };
    }

    const body = await res.json();
    let rawList = [];
    if (body && body.d && Array.isArray(body.d.results)) {
      rawList = body.d.results;
    } else if (body && Array.isArray(body.value)) {
      rawList = body.value;
    } else if (body && Array.isArray(body.d)) {
      rawList = body.d;
    }

    const mappedInvoices = rawList.map(item => mapSapInvoiceRecord(item));
    const checkInvoices = mappedInvoices.map((m, idx) => sapRecordToCheckInvoice(m, idx));

    return {
      ok: true,
      configured: true,
      status: 'Connected',
      message: `Fetched ${mappedInvoices.length} invoice(s) from ${SAP_SOURCE_LABEL}`,
      sourceLabel: SAP_SOURCE_LABEL,
      invoices: mappedInvoices,
      checkInvoices,
    };
  } catch (err) {
    // Never log or expose SAP_API_KEY
    const isTimeout = err && (err.name === 'AbortError' || /abort|timeout/i.test(String(err.message || '')));
    return {
      ok: false,
      configured: true,
      status: 'SAP unavailable',
      message: 'SAP unavailable',
      reason: isTimeout ? 'SAP API request timed out after 5 seconds' : 'Could not reach SAP sandbox endpoint',
      sourceLabel: SAP_SOURCE_LABEL,
      invoices: [],
      checkInvoices: [],
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Looks up a single invoice by reference in SAP sandbox using querySapSandboxInvoices.
 * Used by the SAP match column. Never throws; keeps the invoice check running.
 */
async function checkSapMatchForInvoice(inv = {}, options = {}) {
  const { isConfigured } = getSapConfig();
  if (!isConfigured) {
    return {
      matched: false,
      status: 'Live SAP not configured',
      reason: SAP_SOURCE_LABEL,
      source: SAP_SOURCE_LABEL,
    };
  }

  // If the caller already includes pre-fetched sapFields (e.g. from "Fetch from SAP now")
  if (inv && inv.sapFields && (inv.sapFields.SupplierInvoice || inv.sapFields.SupplierInvoiceIDByInvcgParty)) {
    const rec = inv.sapFields;
    return {
      matched: true,
      status: 'Found in SAP',
      reason: `SAP #${rec.SupplierInvoice || rec.SupplierInvoiceIDByInvcgParty} (${rec.DocumentCurrency ? rec.DocumentCurrency + ' ' : ''}${rec.InvoiceGrossAmount || '-'})`,
      record: rec,
      source: SAP_SOURCE_LABEL,
    };
  }

  // If a batch pre-fetched SAP sandbox list is provided (for large batches so we don't fire 2,000 live HTTP requests)
  if (options.prefetchedSapRes) {
    const pre = options.prefetchedSapRes;
    if (!pre.ok) {
      return {
        matched: false,
        status: pre.status || 'SAP unavailable',
        reason: SAP_SOURCE_LABEL,
        source: SAP_SOURCE_LABEL,
      };
    }
    const refNorm = String(inv.invoiceNo || inv.id || '').trim().toUpperCase();
    const matchedRec = (pre.invoices || []).find(
      r =>
        (r.SupplierInvoiceIDByInvcgParty && r.SupplierInvoiceIDByInvcgParty.toUpperCase() === refNorm) ||
        (r.SupplierInvoice && r.SupplierInvoice.toUpperCase() === refNorm)
    );
    if (matchedRec) {
      return {
        matched: true,
        status: 'Found in SAP',
        reason: `SAP #${matchedRec.SupplierInvoice || matchedRec.SupplierInvoiceIDByInvcgParty} (${matchedRec.DocumentCurrency ? matchedRec.DocumentCurrency + ' ' : ''}${matchedRec.InvoiceGrossAmount || '-'})`,
        record: matchedRec,
        source: SAP_SOURCE_LABEL,
      };
    }
    return {
      matched: false,
      status: 'Not found in SAP',
      reason: SAP_SOURCE_LABEL,
      source: SAP_SOURCE_LABEL,
    };
  }

  if (options.sapCircuitBroken) {
    return {
      matched: false,
      status: 'SAP unavailable',
      reason: SAP_SOURCE_LABEL,
      source: SAP_SOURCE_LABEL,
    };
  }

  const ref = String(inv.invoiceNo || inv.id || '').trim();
  if (!ref) {
    return {
      matched: false,
      status: 'Not found in SAP',
      reason: SAP_SOURCE_LABEL,
      source: SAP_SOURCE_LABEL,
    };
  }

  if (options.cache && options.cache.has(ref)) {
    return options.cache.get(ref);
  }

  const res = await querySapSandboxInvoices({ reference: ref, top: 5, timeoutMs: 5000 });
  if (!res.ok) {
    if (options.onUnavailable) options.onUnavailable();
    const out = {
      matched: false,
      status: res.status || 'SAP unavailable',
      reason: SAP_SOURCE_LABEL,
      source: SAP_SOURCE_LABEL,
    };
    if (options.cache) options.cache.set(ref, out);
    return out;
  }

  if (res.invoices && res.invoices.length > 0) {
    const first = res.invoices[0];
    const out = {
      matched: true,
      status: 'Found in SAP',
      reason: `SAP #${first.SupplierInvoice || first.SupplierInvoiceIDByInvcgParty || ref} (${first.DocumentCurrency ? first.DocumentCurrency + ' ' : ''}${first.InvoiceGrossAmount || '-'})`,
      record: first,
      source: SAP_SOURCE_LABEL,
    };
    if (options.cache) options.cache.set(ref, out);
    return out;
  }

  const out = {
    matched: false,
    status: 'Not found in SAP',
    reason: SAP_SOURCE_LABEL,
    source: SAP_SOURCE_LABEL,
  };
  if (options.cache) options.cache.set(ref, out);
  return out;
}

module.exports = {
  DEFAULT_SAP_API_URL,
  SAP_SOURCE_LABEL,
  SAP_FIELDS,
  formatODataDate,
  mapSapInvoiceRecord,
  sapRecordToCheckInvoice,
  getSapConfig,
  querySapSandboxInvoices,
  checkSapMatchForInvoice,
};
