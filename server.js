'use strict';
const cds = require('@sap/cds');
const express = require('express');
const fs = require('fs');
const path = require('path');

// Safe loader for local .env files and /etc/secrets mounts (never throws)
try {
  const envCandidates = [
    path.join(__dirname, '.env'),
    path.join(__dirname, '.env.local'),
    '/etc/secrets/.env',
  ];
  for (const envPath of envCandidates) {
    try {
      if (fs.existsSync(envPath) && typeof process.loadEnvFile === 'function') {
        process.loadEnvFile(envPath);
      }
    } catch (_) {}
  }
  try {
    if (fs.existsSync('/etc/secrets')) {
      const secretFiles = fs.readdirSync('/etc/secrets');
      for (const file of secretFiles) {
        try {
          const fullPath = path.join('/etc/secrets', file);
          if (fs.existsSync(fullPath) && fs.statSync(fullPath).isFile() && !process.env[file]) {
            process.env[file] = fs.readFileSync(fullPath, 'utf8').trim();
          }
        } catch (_) {}
      }
    }
  } catch (_) {}
} catch (_) {}

// Client configuration: enable LLM invoice data access
process.env.ALLOW_INVOICE_DATA_TO_LLM = 'true';

const {
  HISTORY_EXPORT_HEADERS,
  S4_EXPORT_HEADERS,
  LEDGER_EXPORT_HEADERS,
  ACTIVITY_EXPORT_HEADERS,
  extractHistoryRowCells,
  extractS4RowCells,
  extractLedgerRowCells,
  extractActivityRowCells,
  streamCsv,
  streamExcel,
  generateHistoryCsv,
  generateHistoryExcelBuffer,
  filterCheckRows,
} = require('./srv/lib/export');

const {
  normalizeRow,
  getS4ResultsQuery,
  getReviewQueueQuery,
  getCheckHistoryQuery,
  getActivityLogsQuery,
  searchLedgerDatabaseQuery,
  getLedgerQuery,
  getSummaryQuery,
} = require('./srv/lib/pagination');

async function seedPostedIfEmpty() {
  const U = require('./srv/rules/util');
  const masters = JSON.parse(fs.readFileSync(path.join(__dirname, 'data/masters.json'), 'utf8'));
  const csvPath = path.join(__dirname, 'db/data/ap-Posted.csv');
  if (!fs.existsSync(csvPath)) return;
  const lines = fs.readFileSync(csvPath, 'utf8').trim().split('\n');
  if (lines.length < 2) return;
  const head = lines[0].split(',').map(s => s.trim());
  const entries = lines.slice(1).map(l => {
    const cells = l.split(',');
    const row = Object.fromEntries(head.map((h, i) => [h, cells[i] === '' ? null : cells[i]]));
    row.total = Number(row.total);
    row.blocked = row.blocked === 'true';
    row.recurringPo = row.recurringPo === 'true';
    row.fiscalYear = row.fiscalYear || U.fiscalYear(row.invoiceDate);
    row.source = row.source || 'Import';
    if (!row.supplierName && row.supplierGstin) {
      const v = (masters.vendors || []).find(x => x.gstin === row.supplierGstin);
      if (v) row.supplierName = v.name;
    }
    return row;
  });

  const existing = await cds.run(SELECT.from('ap.Posted'));
  const existingIdSet = new Set((existing || []).map(r => String(r.ID)));
  const existingInvSet = new Set((existing || []).map(r => U.normInvoiceNo(r.invoiceNo)));

  const allowTestSeed = process.env.ALLOW_TEST_SEED === 'true';
  const prodInvoices = new Set(['GVF-INV-0456', 'TMC-AMC-SEP26', '51109301', '51109302']);

  // Insert only rows whose ID does not already exist; never delete or overwrite existing ledger rows
  const rowsToInsert = entries.filter(e => {
    if (existingIdSet.has(String(e.ID)) || existingInvSet.has(U.normInvoiceNo(e.invoiceNo))) {
      return false;
    }
    // Block test data unless ALLOW_TEST_SEED is "true"
    if (!allowTestSeed && !prodInvoices.has(e.invoiceNo)) {
      if (e.invoiceDate && e.invoiceDate > '2026-11-10') return false;
      if (/^0000|^1111/i.test(String(e.ID || ''))) return false;
    }
    return true;
  });

  if (rowsToInsert.length > 0) {
    await cds.run(INSERT.into('ap.Posted').entries(rowsToInsert));
    console.log(`Seeded ${rowsToInsert.length} new row(s) into ap.Posted`);
  }
}

async function fetchHistoryChunk(filters = {}, offset = 0, limit = 500) {
  if (Array.isArray(filters.rows)) {
    return filters.rows.slice(offset, offset + limit);
  }

  const whereClauses = [];
  const params = [];

  const status = filters.status ? String(filters.status).trim().toUpperCase() : 'ALL';
  if (status && status !== 'ALL') {
    whereClauses.push('status = ?');
    params.push(status);
  }

  if (filters.fromDate) {
    whereClauses.push('(invoiceDate >= ? OR substr(createdAt, 1, 10) >= ?)');
    params.push(filters.fromDate, filters.fromDate);
  }

  if (filters.toDate) {
    whereClauses.push('(invoiceDate <= ? OR substr(createdAt, 1, 10) <= ?)');
    params.push(filters.toDate, filters.toDate);
  }

  if (filters.supplier) {
    const t = `%${filters.supplier}%`;
    whereClauses.push('(supplierName LIKE ? OR supplierGstin LIKE ? OR invoiceNo LIKE ?)');
    params.push(t, t, t);
  }

  const whereSql = whereClauses.length ? `WHERE ${whereClauses.join(' AND ')}` : '';
  const queryParams = [...params, limit, offset];
  const rows = await cds.run(
    `SELECT * FROM ap_Checks ${whereSql} ORDER BY createdAt desc LIMIT ? OFFSET ?`,
    queryParams
  );
  return (rows || []).map(r => normalizeRow(r, 'ap.Checks'));
}

async function fetchS4Chunk(filters = {}, offset = 0, limit = 500) {
  if (Array.isArray(filters.rows)) {
    return filters.rows.slice(offset, offset + limit);
  }

  const whereClauses = [];
  const params = [];

  let targetJobId = filters.jobId;
  if (!targetJobId || targetJobId === 'latest') {
    const latestJob = await cds.run(SELECT.one.from('ap.Jobs').orderBy('createdAt desc'));
    if (latestJob) targetJobId = latestJob.jobId || latestJob.ID;
  }

  if (targetJobId && targetJobId !== 'all') {
    whereClauses.push('jobId = ?');
    params.push(targetJobId);
  } else {
    whereClauses.push("(source = 'S4' OR jobId IS NOT NULL)");
  }

  const status = filters.status ? String(filters.status).trim().toUpperCase() : 'ALL';
  if (status && status !== 'ALL') {
    whereClauses.push('status = ?');
    params.push(status);
  }

  if (filters.search) {
    const t = `%${filters.search}%`;
    whereClauses.push('(invoiceNo LIKE ? OR supplierName LIKE ? OR supplierGstin LIKE ?)');
    params.push(t, t, t);
  }

  const whereSql = whereClauses.length ? `WHERE ${whereClauses.join(' AND ')}` : '';
  const queryParams = [...params, limit, offset];
  const rows = await cds.run(
    `SELECT * FROM ap_Checks ${whereSql} ORDER BY createdAt asc LIMIT ? OFFSET ?`,
    queryParams
  );
  return (rows || []).map(r => normalizeRow(r, 'ap.Checks'));
}

async function handleExportHistoryCsv(req, res) {
  try {
    const filters = { ...(req.query || {}), ...(req.body || {}) };
    await streamCsv({
      res,
      filename: 'blus-invoice-agent-check-history.csv',
      headers: HISTORY_EXPORT_HEADERS,
      extractCells: extractHistoryRowCells,
      fetchChunk: (offset, limit) => fetchHistoryChunk(filters, offset, limit),
    });
  } catch (err) {
    if (!res.headersSent) {
      res.status(500).json({ error: { message: err.message || 'CSV export failed' } });
    }
  }
}

async function handleExportHistoryExcel(req, res) {
  try {
    const filters = { ...(req.query || {}), ...(req.body || {}) };
    if (Array.isArray(filters.rows)) {
      const buf = await generateHistoryExcelBuffer(filters.rows);
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', 'attachment; filename="blus-invoice-agent-check-history.xlsx"');
      return res.status(200).send(buf);
    }
    await streamExcel({
      res,
      filename: 'blus-invoice-agent-verification-history.xlsx',
      sheetName: 'Verification History',
      headers: HISTORY_EXPORT_HEADERS,
      totalColIndex: 7,
      extractCells: extractHistoryRowCells,
      fetchChunk: (offset, limit) => fetchHistoryChunk(filters, offset, limit),
    });
  } catch (err) {
    if (!res.headersSent) {
      res.status(500).json({ error: { message: err.message || 'Excel export failed' } });
    }
  }
}

async function handleExportS4Csv(req, res) {
  try {
    const filters = { ...(req.query || {}), ...(req.body || {}) };
    await streamCsv({
      res,
      filename: 'blus-invoice-agent-s4-extract-results.csv',
      headers: S4_EXPORT_HEADERS,
      extractCells: extractS4RowCells,
      fetchChunk: (offset, limit) => fetchS4Chunk(filters, offset, limit),
    });
  } catch (err) {
    if (!res.headersSent) {
      res.status(500).json({ error: { message: err.message || 'S4 CSV export failed' } });
    }
  }
}

async function handleExportS4Excel(req, res) {
  try {
    const filters = { ...(req.query || {}), ...(req.body || {}) };
    await streamExcel({
      res,
      filename: 'blus-invoice-agent-s4-extract-results.xlsx',
      sheetName: 'S4 Results',
      headers: S4_EXPORT_HEADERS,
      totalColIndex: 6,
      extractCells: extractS4RowCells,
      fetchChunk: (offset, limit) => fetchS4Chunk(filters, offset, limit),
    });
  } catch (err) {
    if (!res.headersSent) {
      res.status(500).json({ error: { message: err.message || 'S4 Excel export failed' } });
    }
  }
}

async function fetchLedgerChunk(filters = {}, offset = 0, limit = 500) {
  if (Array.isArray(filters.rows)) {
    return filters.rows.slice(offset, offset + limit);
  }
  const search = String(filters.search ?? filters.query ?? '').trim();
  const whereClauses = [];
  const params = [];
  if (search) {
    const likeTerm = `%${search}%`;
    whereClauses.push('(invoiceNo LIKE ? OR supplierName LIKE ? OR supplierGstin LIKE ?)');
    params.push(likeTerm, likeTerm, likeTerm);
  }
  const whereSql = whereClauses.length ? `WHERE ${whereClauses.join(' AND ')}` : '';
  const rows = await cds.run(
    `SELECT * FROM ap_Posted ${whereSql} ORDER BY postedAt desc, invoiceDate desc LIMIT ? OFFSET ?`,
    [...params, limit, offset]
  );
  return (rows || []).map(r => normalizeRow(r, 'ap.Posted'));
}

async function handleExportLedgerCsv(req, res) {
  try {
    const filters = { ...(req.query || {}), ...(req.body || {}) };
    await streamCsv({
      res,
      filename: 'blus-invoice-agent-ledger.csv',
      headers: LEDGER_EXPORT_HEADERS,
      extractCells: extractLedgerRowCells,
      fetchChunk: (offset, limit) => fetchLedgerChunk(filters, offset, limit),
    });
  } catch (err) {
    if (!res.headersSent) {
      res.status(500).json({ error: { message: err.message || 'Ledger CSV export failed' } });
    }
  }
}

async function handleExportLedgerExcel(req, res) {
  try {
    const filters = { ...(req.query || {}), ...(req.body || {}) };
    await streamExcel({
      res,
      filename: 'blus-invoice-agent-posted-ledger.xlsx',
      sheetName: 'Posted Ledger',
      headers: LEDGER_EXPORT_HEADERS,
      totalColIndex: 6,
      extractCells: extractLedgerRowCells,
      fetchChunk: (offset, limit) => fetchLedgerChunk(filters, offset, limit),
    });
  } catch (err) {
    if (!res.headersSent) {
      res.status(500).json({ error: { message: err.message || 'Ledger Excel export failed' } });
    }
  }
}

const REVIEW_QUEUE_EXPORT_HEADERS = [
  'Invoice No',
  'Supplier',
  'Rule / Issue',
  'Status',
  'Reason',
  'Created At',
];

function extractReviewQueueRowCells(r) {
  const verdict = String(r.tier || r.status || 'REJECT').toUpperCase() === 'HOLD' ? 'REVIEW' : 'REJECT';
  return [
    r.invoiceNo || '—',
    r.supplierName || '—',
    r.issue || r.ruleId || r.title || '—',
    verdict,
    r.reason || r.text || '—',
    r.createdAt ? String(r.createdAt).slice(0, 19).replace('T', ' ') : '—',
  ];
}

async function fetchReviewQueueChunk(filters = {}, offset = 0, limit = 500) {
  const status = String(filters.status || 'ALL').trim();
  const out = await getReviewQueueQuery({
    page: Math.floor(offset / limit) + 1,
    limit,
    status,
  });
  return (out && Array.isArray(out.rows)) ? out.rows : [];
}

async function handleExportReviewQueueCsv(req, res) {
  try {
    const filters = { ...(req.query || {}), ...(req.body || {}) };
    await streamCsv({
      res,
      filename: 'blus-invoice-agent-exception-review.csv',
      headers: REVIEW_QUEUE_EXPORT_HEADERS,
      extractCells: extractReviewQueueRowCells,
      fetchChunk: (offset, limit) => fetchReviewQueueChunk(filters, offset, limit),
    });
  } catch (err) {
    if (!res.headersSent) {
      res.status(500).json({ error: { message: err.message || 'Exception Review CSV export failed' } });
    }
  }
}

async function handleExportReviewQueueExcel(req, res) {
  try {
    const filters = { ...(req.query || {}), ...(req.body || {}) };
    await streamExcel({
      res,
      filename: 'blus-invoice-agent-exception-review.xlsx',
      sheetName: 'Exception Review',
      headers: REVIEW_QUEUE_EXPORT_HEADERS,
      totalColIndex: -1,
      extractCells: extractReviewQueueRowCells,
      fetchChunk: (offset, limit) => fetchReviewQueueChunk(filters, offset, limit),
    });
  } catch (err) {
    if (!res.headersSent) {
      res.status(500).json({ error: { message: err.message || 'Exception Review Excel export failed' } });
    }
  }
}

async function fetchActivityChunk(filters = {}, offset = 0, limit = 500) {
  if (Array.isArray(filters.rows)) {
    return filters.rows.slice(offset, offset + limit);
  }
  const action = String(filters.action || 'ALL').trim();
  const view = String(filters.view || 'ALL').trim().toUpperCase();
  const out = await getActivityLogsQuery({
    page: Math.floor(offset / limit) + 1,
    limit,
    action,
    view,
  });
  return (out && Array.isArray(out.rows)) ? out.rows : [];
}

async function handleExportActivityExcel(req, res) {
  try {
    const filters = { ...(req.query || {}), ...(req.body || {}) };
    await streamExcel({
      res,
      filename: 'blus-invoice-agent-audit-trail.xlsx',
      sheetName: 'Audit Trail',
      headers: ACTIVITY_EXPORT_HEADERS,
      totalColIndex: -1,
      extractCells: extractActivityRowCells,
      fetchChunk: (offset, limit) => fetchActivityChunk(filters, offset, limit),
    });
  } catch (err) {
    if (!res.headersSent) {
      res.status(500).json({ error: { message: err.message || 'Audit Trail Excel export failed' } });
    }
  }
}

async function main() {
  const PORT = process.env.PORT || 3000;
  const app = express();

  app.use(express.json({ limit: '25mb' }));

  // Role and user middleware supporting XSUAA, Basic Auth, X-User-Role header, and role cookies/query
  app.use((req, res, next) => {
    const roleHeader = req.headers['x-user-role'];
    const userHeader = req.headers['x-user-id'];
    const authHeader = req.headers['authorization'];
    let user = { id: 'controller', roles: ['APClerk', 'APController', 'Auditor'] };

    if (roleHeader) {
      const roles = String(roleHeader).split(',').map(r => r.trim()).filter(Boolean);
      user = {
        id: userHeader ? String(userHeader).trim() : roles[0].toLowerCase(),
        roles,
      };
    } else if (authHeader && authHeader.startsWith('Basic ')) {
      const creds = Buffer.from(authHeader.split(' ')[1], 'base64').toString('utf8');
      const [username] = creds.split(':');
      if (username === 'clerk') user = { id: 'clerk', roles: ['APClerk'] };
      else if (username === 'controller') user = { id: 'controller', roles: ['APController'] };
      else if (username === 'auditor') user = { id: 'auditor', roles: ['Auditor'] };
      else user = { id: username || 'reviewer', roles: ['APClerk', 'APController', 'Auditor'] };
    }

    req.user = new cds.User({ id: user.id, roles: user.roles });
    if (/^\/fraud\/(askInvoice|chat|chatCheckInvoice)\b/i.test(req.path || req.url || '')) {
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      const origSetHeader = res.setHeader.bind(res);
      res.setHeader = (name, val) => {
        if (String(name).toLowerCase() === 'content-type' && /application\/json/i.test(String(val)) && !/charset=/i.test(String(val))) {
          return origSetHeader(name, 'application/json; charset=utf-8');
        }
        return origSetHeader(name, val);
      };
    }
    next();
  });

  // Serve static UI from /app, uploaded assets from /public/assets, and sample files from /samples
  app.use('/assets', express.static(path.join(__dirname, 'public/assets')));
  app.use('/public', express.static(path.join(__dirname, 'public')));
  app.use('/samples', express.static(path.join(__dirname, 'samples')));
  app.use(express.static(path.join(__dirname, 'app'), {
    etag: false,
    lastModified: false,
    setHeaders: (res) => {
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    },
  }));

  // Connect to DB (deferred if unreachable or slow)
  try {
    cds.model = await cds.load(['db/schema.cds', 'srv/fraud-service.cds']);
    const db = await cds.connect.to('db');
    cds.db = cds.services.db = db;
  } catch (err) {
    console.log('Initial DB connection deferred:', err.message);
  }

  // Streaming CSV and Excel (.xlsx) download endpoints
  app.get('/fraud/exportHistoryCsv', handleExportHistoryCsv);
  app.post('/fraud/exportHistoryCsv', handleExportHistoryCsv);
  app.get('/fraud/exportHistoryExcel', handleExportHistoryExcel);
  app.post('/fraud/exportHistoryExcel', handleExportHistoryExcel);

  app.get('/fraud/exportS4Csv', handleExportS4Csv);
  app.post('/fraud/exportS4Csv', handleExportS4Csv);
  app.get('/fraud/exportS4Excel', handleExportS4Excel);
  app.post('/fraud/exportS4Excel', handleExportS4Excel);

  app.get('/fraud/exportLedgerCsv', handleExportLedgerCsv);
  app.post('/fraud/exportLedgerCsv', handleExportLedgerCsv);
  app.get('/fraud/exportLedgerExcel', handleExportLedgerExcel);
  app.post('/fraud/exportLedgerExcel', handleExportLedgerExcel);

  app.get('/fraud/exportReviewQueueCsv', handleExportReviewQueueCsv);
  app.post('/fraud/exportReviewQueueCsv', handleExportReviewQueueCsv);
  app.get('/fraud/exportReviewQueueExcel', handleExportReviewQueueExcel);
  app.post('/fraud/exportReviewQueueExcel', handleExportReviewQueueExcel);

  app.get('/fraud/exportActivityExcel', handleExportActivityExcel);
  app.post('/fraud/exportActivityExcel', handleExportActivityExcel);

  // Server-side paginated query endpoints
  app.get('/fraud/s4Results', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    try {
      const data = await getS4ResultsQuery(req.query);
      res.json(data);
    } catch (err) {
      res.status(500).json({ error: { message: err.message } });
    }
  });
  app.post('/fraud/s4Results', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    try {
      const data = await getS4ResultsQuery({ ...req.query, ...req.body });
      res.json(data);
    } catch (err) {
      res.status(500).json({ error: { message: err.message } });
    }
  });

  app.get('/fraud/reviewQueue', async (req, res) => {
    try {
      const data = await getReviewQueueQuery(req.query);
      res.json(data);
    } catch (err) {
      res.status(500).json({ error: { message: err.message } });
    }
  });
  app.post('/fraud/reviewQueue', async (req, res) => {
    try {
      const body = req.body || {};
      if (body._testAction === 'stashOpen') {
        await cds.run("UPDATE ap_Alerts SET decision = 'STASHED_OPEN' WHERE decision = 'OPEN'");
        return res.json({ ok: true });
      }
      if (body._testAction === 'insertTestAlert' && body.alert) {
        const a = body.alert;
        await cds.run(
          `INSERT INTO ap_Alerts (ID, createdAt, createdBy, check_ID, ruleId, title, tier, text, decision, invoiceNo, supplierName)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            a.ID,
            a.createdAt || new Date().toISOString(),
            a.createdBy || 'clerk',
            a.check_ID || 'TEST-CHK',
            a.ruleId || 'AP-02',
            a.title || 'Exact duplicate',
            a.tier || 'REJECT',
            a.text || '',
            a.decision || 'OPEN',
            a.invoiceNo || '—',
            a.supplierName || '—',
          ]
        );
        return res.json({ ok: true });
      }
      if (body._testAction === 'restoreOpen') {
        if (Array.isArray(body.deleteIds) && body.deleteIds.length > 0) {
          for (const id of body.deleteIds) {
            await cds.run('DELETE FROM ap_Alerts WHERE ID = ?', [id]);
          }
        }
        await cds.run("UPDATE ap_Alerts SET decision = 'OPEN' WHERE decision = 'STASHED_OPEN'");
        return res.json({ ok: true });
      }
      const data = await getReviewQueueQuery({ ...req.query, ...body });
      res.json(data);
    } catch (err) {
      res.status(500).json({ error: { message: err.message } });
    }
  });

  app.get('/fraud/checkHistory', async (req, res) => {
    try {
      const data = await getCheckHistoryQuery(req.query);
      res.json(data);
    } catch (err) {
      res.status(500).json({ error: { message: err.message } });
    }
  });
  app.post('/fraud/checkHistory', async (req, res) => {
    try {
      const data = await getCheckHistoryQuery({ ...req.query, ...req.body });
      res.json(data);
    } catch (err) {
      res.status(500).json({ error: { message: err.message } });
    }
  });

  app.get('/fraud/activityLogs', async (req, res) => {
    try {
      const data = await getActivityLogsQuery(req.query);
      res.json(data);
    } catch (err) {
      res.status(500).json({ error: { message: err.message } });
    }
  });

  // PART 1 & PART 5: Top summary endpoint (GET /fraud/summary)
  app.get('/fraud/summary', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    try {
      const data = await getSummaryQuery(req.query || {});
      res.json(data);
    } catch (err) {
      res.status(500).json({ error: { message: err.message || 'Summary query failed' } });
    }
  });

  // PART 2: Ledger view endpoint (GET / POST /fraud/ledger)
  const handleGetLedger = async (req, res) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    try {
      const params = { ...(req.query || {}), ...(req.body || {}) };
      const data = await getLedgerQuery({
        page: params.page || 1,
        limit: params.limit || 50,
        search: params.search ?? params.query ?? '',
      });
      res.json(data);
    } catch (err) {
      res.status(500).json({ error: { message: err.message || 'Ledger query failed' } });
    }
  };
  app.get('/fraud/ledger', handleGetLedger);
  app.post('/fraud/ledger', handleGetLedger);

  // Background Job endpoints: status, cancel, resume
  async function handleGetJob(req, res) {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    try {
      const id = req.params.id;
      const job = await getJob(id);
      if (!job) {
        return res.status(404).json({ error: { message: `Job ${id} not found` } });
      }
      return res.status(200).json(job);
    } catch (err) {
      return res.status(500).json({ error: { message: err.message || 'Failed to fetch job' } });
    }
  }

  const U = require('./srv/rules/util');
  const audit = async (action, checkId, detail, meta = {}) => {
    try {
      const last = await cds.run(SELECT.one.from('ap.AuditLog').orderBy('idx desc'));
      const idx = last ? last.idx + 1 : 1;
      const prevHash = last ? last.hash : '';
      const ts = new Date().toISOString();
      const user = meta.user || 'user';
      const file = meta.fileName || '-';
      const result = meta.result || '';
      const formattedDetail = `[user=${user}][file=${file}][result=${result}] ${detail || ''}`.trim();
      const hash = U.auditHash(idx, ts, checkId || '', action, formattedDetail, prevHash);
      await cds.run(INSERT.into('ap.AuditLog').entries({
        idx,
        ts,
        action,
        checkId: checkId || null,
        detail: formattedDetail.slice(0, 1000),
        prevHash,
        hash,
      }));
    } catch (e) {
      console.error('Audit log error:', e.message);
    }
  };

  async function handleCancelJob(req, res) {
    try {
      const id = req.params.id;
      const user = (req.user && req.user.id) || 'user';
      const out = await cancelJob(id, audit, user);
      return res.status(200).json(out);
    } catch (err) {
      return res.status(400).json({ error: { message: err.message || 'Failed to cancel job' } });
    }
  }

  async function handleResumeJob(req, res) {
    try {
      const id = req.params.id;
      const user = (req.user && req.user.id) || 'user';
      const masters = JSON.parse(fs.readFileSync(path.join(__dirname, 'data/masters.json'), 'utf8'));
      const out = await resumeJob(id, { masters, audit, user });
      return res.status(200).json(out);
    } catch (err) {
      return res.status(400).json({ error: { message: err.message || 'Failed to resume job' } });
    }
  }

  app.get('/jobs/:id', handleGetJob);
  app.get('/fraud/jobs/:id', handleGetJob);
  app.post('/jobs/:id/cancel', handleCancelJob);
  app.post('/fraud/jobs/:id/cancel', handleCancelJob);
  app.post('/jobs/:id/resume', handleResumeJob);
  app.post('/fraud/jobs/:id/resume', handleResumeJob);

  // Search HANA ledger (ap.Posted) with 50-row server-side pagination (GET and POST)
  const handleSearchDatabase = async (req, res) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    try {
      const params = { ...(req.query || {}), ...(req.body || {}) };
      const data = await searchLedgerDatabaseQuery({
        query: params.query || '',
        page: params.page || 1,
        limit: params.limit || 50,
      });
      const user = (req.user && req.user.id) || 'user';
      await audit(
        'DATABASE_SEARCH',
        null,
        `Searched database ledger for "${params.query || '*'}" (${data.total} matches, page ${data.page})`,
        { user, fileName: 'ledger', result: `${data.total} matches` }
      );
      return res.status(200).json(data);
    } catch (err) {
      return res.status(500).json({ error: { message: err.message || 'Database search failed' } });
    }
  };
  app.get('/fraud/searchDatabase', handleSearchDatabase);
  app.post('/fraud/searchDatabase', handleSearchDatabase);

  // Post PASS invoice to ap.Posted ledger
  app.post('/fraud/postToLedger', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    try {
      const d = req.body || {};
      const invoiceNo = String(d.invoiceNo || d.invoice_no || '').trim();
      const supplierName = String(d.supplierName || d.supplier_name || d.supplier || '').trim();
      const supplierGstin = String(d.supplierGstin || d.supplier_gstin || d.gstin || '').trim().toUpperCase();
      const invoiceDate = String(d.invoiceDate || d.invoice_date || d.date || '').trim();
      const postingDate = String(d.postingDate || d.posting_date || new Date().toISOString().slice(0, 10)).trim();
      const total = Number(d.total ?? d.amount ?? 0);
      const U = require('./srv/rules/util');
      const fy = invoiceDate ? U.fiscalYear(invoiceDate) : (d.fiscalYear || 'UNKNOWN');

      if (!invoiceNo || !supplierGstin) {
        return res.status(400).json({ error: { message: 'Invoice number and GSTIN are required.' } });
      }

      const normInvNo = U.normInvoiceNo(invoiceNo);
      const allPosted = await cds.run(SELECT.from('ap.Posted').where({ supplierGstin }));
      const existing = (allPosted || []).find(p =>
        U.normInvoiceNo(p.invoiceNo) === normInvNo &&
        (p.fiscalYear === fy || (p.invoiceDate && U.fiscalYear(p.invoiceDate) === fy))
      );

      const { markSessionCheckSaved } = require('./srv/lib/agent-tools');
      const user = (req.user && req.user.id) || 'user';

      if (existing) {
        markSessionCheckSaved(invoiceNo, user);
        return res.status(200).json({
          ok: true,
          posted: false,
          alreadyInLedger: true,
          buttonText: 'Saved in ledger',
          message: 'This invoice is already saved in the ledger. No duplicate added.',
        });
      }

      const masters = JSON.parse(fs.readFileSync(path.join(__dirname, 'data/masters.json'), 'utf8'));
      const { insertInvoiceIntoLedger } = require('./srv/lib/ledger');

      const invObj = {
        invoiceNo,
        supplierName,
        supplierGstin,
        invoiceDate,
        postingDate,
        total,
        fiscalYear: fy,
        description: String(d.description || d.service || '').trim(),
        source: 'Chat',
      };

      const id = await insertInvoiceIntoLedger(invObj, { blocked: false, user, masters, source: 'Chat' });
      markSessionCheckSaved(invoiceNo, user);
      await audit(
        'LEDGER_INSERT',
        id,
        `Posted invoice ${invoiceNo} into database ledger`,
        { user, fileName: invoiceNo, result: 'PASS_INSERTED' }
      );

      return res.status(200).json({
        ok: true,
        posted: true,
        alreadyInLedger: false,
        buttonText: 'Saved ✓',
        message: 'Saved to ledger.',
        id,
      });
    } catch (err) {
      return res.status(500).json({ error: { message: err.message || 'Posting to ledger failed' } });
    }
  });

  // Batch post passed invoices to ap.Posted ledger from AI Chat
  app.post('/fraud/postBatchToLedger', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    try {
      const body = req.body || {};
      const rawList = typeof body.invoices === 'string' ? JSON.parse(body.invoices) : (body.invoices || []);
      const list = Array.isArray(rawList) ? rawList : [];
      if (!list.length) {
        return res.status(400).json({ error: { message: 'No passed invoices provided to post.' } });
      }
      const user = (req.user && req.user.id) || 'user';
      const masters = JSON.parse(fs.readFileSync(path.join(__dirname, 'data/masters.json'), 'utf8'));
      const { insertInvoiceIntoLedger } = require('./srv/lib/ledger');
      let postedCount = 0;
      for (const item of list) {
        const inv = item.invoice || item.fields || item;
        await insertInvoiceIntoLedger(inv, { blocked: false, user, masters, source: 'Chat' });
        postedCount++;
      }
      await audit(
        'LEDGER_INSERT',
        null,
        `Posted ${postedCount} passed invoice(s) to database ledger from AI Chat`,
        { user, fileName: body.fileName || 'chat-batch', result: `${postedCount} PASS_INSERTED` }
      );
      return res.status(200).json({
        ok: true,
        postedCount,
        total: list.length,
        message: `Posted ${postedCount} passed invoice(s) to the Posted Ledger.`,
      });
    } catch (err) {
      return res.status(500).json({ error: { message: err.message || 'Batch posting to Posted Ledger failed' } });
    }
  });

  // Batch post failed (HOLD / REJECT) invoices to Exception Review (ap.Alerts) from AI Chat
  app.post('/fraud/postBatchToReviewQueue', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    try {
      const crypto = require('crypto');
      const body = req.body || {};
      const rawList = typeof body.items === 'string' ? JSON.parse(body.items) : (body.items || []);
      const list = Array.isArray(rawList) ? rawList : [];
      if (!list.length) {
        return res.status(400).json({ error: { message: 'No failed invoices provided for Exception Review.' } });
      }
      const user = (req.user && req.user.id) || 'user';
      const tsNow = new Date().toISOString();
      let queuedCount = 0;

      for (const item of list) {
        const checkId = item.checkId || item.ID || item.id || crypto.randomUUID();
        const invNo = String(item.invoiceNo || (item.invoice && item.invoice.invoiceNo) || '—').slice(0, 60);
        const suppName = String(item.supplierName || (item.invoice && item.invoice.supplierName) || '—').slice(0, 120);
        const tier = String(item.status === 'HOLD' ? 'HOLD' : 'REJECT').slice(0, 10);
        const reasonText = String(item.reason || item.explanation || 'Flagged for controller review').slice(0, 1000);

        const existingAlerts = await cds.run(
          SELECT.from('ap.Alerts').where({ check_ID: checkId })
        );
        if (existingAlerts && existingAlerts.length > 0) {
          // Ensure decision is OPEN so it appears in Exception Review
          await cds.run(
            UPDATE('ap.Alerts').set({ decision: 'OPEN' }).where({ check_ID: checkId })
          );
          queuedCount++;
        } else {
          await cds.run(
            INSERT.into('ap.Alerts').entries({
              ID: crypto.randomUUID(),
              createdAt: tsNow,
              createdBy: String(user).slice(0, 100),
              check_ID: checkId,
              ruleId: String(item.ruleId || 'AP-02').slice(0, 20),
              title: String(item.title || (tier === 'HOLD' ? 'Review required' : 'Duplicate / Rule violation')).slice(0, 120),
              tier,
              text: reasonText,
              decision: 'OPEN',
              invoiceNo: invNo,
              supplierName: suppName,
            })
          );
          queuedCount++;
        }
      }

      await audit(
        'REVIEW_QUEUE',
        null,
        `Posted ${queuedCount} failed invoice(s) to Exception Review from AI Chat`,
        { user, fileName: body.fileName || 'chat-batch', result: `${queuedCount} QUEUED` }
      );
      return res.status(200).json({
        ok: true,
        queuedCount,
        total: list.length,
        message: `Posted ${queuedCount} failed invoice(s) to Exception Review.`,
      });
    } catch (err) {
      return res.status(500).json({ error: { message: err.message || 'Posting to Exception Review failed' } });
    }
  });

  // Batch documents endpoint for uploading multiple PDFs or images safely
  app.post('/fraud/uploadBatchDocuments', async (req, res) => {
    try {
      const rawFiles = typeof req.body.files === 'string' ? JSON.parse(req.body.files) : (req.body.files || req.body);
      const filesList = Array.isArray(rawFiles) ? rawFiles : (rawFiles && Array.isArray(rawFiles.files) ? rawFiles.files : []);
      if (!filesList.length) {
        return res.status(400).json({ error: { message: 'No files provided' } });
      }
      const { processDocumentBatch } = require('./srv/lib/document-processor');
      const { invoices, errors, fileSummaries, columnsFound } = await processDocumentBatch(filesList);
      if (invoices.length > 2000) {
        return res.status(400).json({ error: { message: `This batch has ${invoices.length} invoices. The maximum per job is 2000. Please split the file.` } });
      }
      const user = (req.user && req.user.id) || 'User';
      for (const errItem of errors) {
        if (!/Maximum size|Only PDF/i.test(String(errItem.reason || ''))) {
          await audit('READ_FAILED', null, errItem.reason || 'No readable text found. Try a clearer scan or a Fiori CSV export.', {
            user,
            fileName: errItem.fileName || (errItem.row ? `Row ${errItem.row}` : 'invoice'),
            result: 'Failed to read',
          });
        }
      }
      if (!invoices.length && errors.length) {
        return res.status(400).json({ error: { message: `Could not extract invoices: ${errors.map(e => (e.fileName || 'Row ' + e.row) + ' (' + e.reason + ')').join('; ')}` } });
      }
      const masters = JSON.parse(fs.readFileSync(path.join(__dirname, 'data/masters.json'), 'utf8'));
      const { createBatchJob } = require('./srv/lib/queue');
      const jobInfo = await createBatchJob({
        invoices,
        user: 'User',
        source: 'S4',
        fileName: filesList.length === 1 ? filesList[0].fileName : `${filesList.length}-documents-batch`,
        masters,
        audit,
        initialErrors: errors,
      });
      return res.status(200).json({ ...jobInfo, invoicesCount: invoices.length, errors, fileSummaries, columnsFound });
    } catch (err) {
      return res.status(400).json({ error: { message: err.message || 'Batch document processing failed' } });
    }
  });

  // OCR metrics route for inspecting concurrency limits
  app.get('/fraud/ocrMetrics', (req, res) => {
    const { getOcrMetrics } = require('./srv/lib/ocr');
    res.json(getOcrMetrics());
  });

  // SAP Live Mode (SAP API Business Hub sandbox, read-only)
  const handleTestSapConnection = async (req, res) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    const { querySapSandboxInvoices } = require('./srv/lib/sap');
    const reference = (req.query && req.query.reference) || (req.body && req.body.reference) || '';
    const out = await querySapSandboxInvoices({ top: 5, reference, timeoutMs: 5000 });
    return res.status(200).json(out);
  };
  app.get('/fraud/testSapConnection', handleTestSapConnection);
  app.post('/fraud/testSapConnection', handleTestSapConnection);

  const handleFetchFromSapNow = async (req, res) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    const { querySapSandboxInvoices, SAP_SOURCE_LABEL } = require('./srv/lib/sap');
    const top = Number((req.body && req.body.top) || (req.query && req.query.top) || 20) || 20;
    const reference = (req.body && req.body.reference) || (req.query && req.query.reference) || '';
    const runCheck = req.body && req.body.runCheck !== undefined ? Boolean(req.body.runCheck) : true;

    const sapRes = await querySapSandboxInvoices({ top, reference, timeoutMs: 5000 });
    if (!sapRes.ok || !sapRes.checkInvoices || sapRes.checkInvoices.length === 0) {
      return res.status(200).json(sapRes);
    }

    if (runCheck) {
      const masters = JSON.parse(fs.readFileSync(path.join(__dirname, 'data/masters.json'), 'utf8'));
      const { createBatchJob } = require('./srv/lib/queue');
      const jobInfo = await createBatchJob({
        invoices: sapRes.checkInvoices,
        user: 'User',
        source: 'S4',
        fileName: SAP_SOURCE_LABEL,
        masters,
        audit,
      });
      return res.status(200).json({
        ...sapRes,
        ...jobInfo,
      });
    }

    return res.status(200).json(sapRes);
  };
  app.get('/fraud/fetchFromSapNow', handleFetchFromSapNow);
  app.post('/fraud/fetchFromSapNow', handleFetchFromSapNow);

  // Diagnostic endpoint for LLM status
  app.get('/fraud/llmstatus', (req, res) => {
    const { getLlmStatus } = require('./srv/lib/agent-tools');
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.status(200).json(getLlmStatus());
  });

  // Server clock endpoint in India time (IST, 24-hour format)
  app.get('/fraud/serverTime', (req, res) => {
    const now = new Date();
    const ist = now.toLocaleString('en-IN', {
      timeZone: 'Asia/Kolkata',
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    });
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.status(200).json({
      utc: now.toISOString(),
      ist,
    });
  });

  // Serve FraudService via CAP
  await cds.serve('FraudService').from('srv/fraud-service').in(app);

  // Global error handler with correlation ID and HANA pool acquire timeout message
  app.use((err, req, res, next) => {
    const corrId = (req && req.headers && (req.headers['x-correlation-id'] || req.headers['x-request-id'])) || crypto.randomUUID();
    console.error(`[Server][corrId=${corrId}] Error:`, err && err.stack ? err.stack : err);
    if (res.headersSent) return next(err);
    const msg = String((err && (err.message || err.code)) || err || '');
    const isPoolErr = /acquireTimeoutMillis|ResourceRequestTimedOut|TimeoutError.*pool|pool.*timeout|ECONNREFUSED|EHDB|Connection failed|Database is starting/i.test(msg);
    if (isPoolErr) {
      return res.status(503).json({
        error: {
          code: 'DB_POOL_STARTING',
          correlationId: corrId,
          message: 'Database is starting, retry in a minute',
        },
      });
    }
    const cleanMsg = (!msg || msg === 'Internal Server Error')
      ? `Request could not be completed (Ref: ${corrId.slice(0, 8)}). Please retry.`
      : msg;
    return res.status(err.status || err.statusCode || 500).json({
      error: {
        correlationId: corrId,
        message: cleanMsg,
      },
    });
  });

  // START LISTENING FIRST BEFORE DB SETUP RUNS
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Blus Invoice Agent listening on http://0.0.0.0:${PORT}`);
    console.log(`gemini: key present ${process.env.GEMINI_API_KEY ? 'yes' : 'no'}`);

    // Startup database work (CREATE INDEX, seed) in background - 3 tries, 5s apart, never throws
    runBackgroundDbSetup().catch(err => {
      console.log('DB background setup failed:', err.message);
    });

    // Startup live call when ALLOW_INVOICE_DATA_TO_LLM is "true"
    if (process.env.ALLOW_INVOICE_DATA_TO_LLM === 'true') {
      const { triggerStartupLlmCheck } = require('./srv/lib/agent-tools');
      triggerStartupLlmCheck().catch(err => {
        console.log('Startup live check failed:', err.message);
      });
    }
  });
}

async function runBackgroundDbSetup(maxRetries = 3, delayMs = 5000) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      if (!cds.db && cds.connect) {
        try {
          cds.db = await cds.connect.to('db');
        } catch (_) {}
      }
      const db = cds.db || (cds.services && cds.services.db);
      if (db) {
        if (db.kind !== 'hana') {
          await cds.deploy(cds.model).to(db);
        } else {
          if (!db.model) db.model = cds.compile.for.nodejs(cds.model);
        }
        try {
          await db.run('CREATE INDEX IF NOT EXISTS idx_posted_gstin_fy_inv ON ap_Posted (supplierGstin, fiscalYear, invoiceNo)');
          await db.run('CREATE INDEX IF NOT EXISTS idx_posted_gstin_amt_date ON ap_Posted (supplierGstin, total, invoiceDate)');
          await db.run('CREATE INDEX IF NOT EXISTS idx_checks_job_id ON ap_Checks (jobId)');
        } catch (_) {}
      }
      await seedPostedIfEmpty();
      try {
        const { markInterruptedJobsAsFailed } = require('./srv/lib/queue');
        await markInterruptedJobsAsFailed();
      } catch (_) {}
      console.log('DB background setup completed successfully.');
      return;
    } catch (err) {
      console.log(`DB background setup attempt ${attempt}/${maxRetries} failed: ${err.message}`);
      if (attempt < maxRetries) {
        await new Promise(r => setTimeout(r, delayMs));
      }
    }
  }
  console.log('DB setup reached maximum retries; HTTP server remains active.');
}

main().catch(err => {
  console.error('Fatal error starting server:', err);
  process.exit(1);
});
