'use strict';
const cds = require('@sap/cds');
const express = require('express');
const fs = require('fs');
const path = require('path');

const {
  HISTORY_EXPORT_HEADERS,
  S4_EXPORT_HEADERS,
  extractHistoryRowCells,
  extractS4RowCells,
  streamCsv,
  streamExcel,
  generateHistoryCsv,
  generateHistoryExcelBuffer,
  filterCheckRows,
} = require('./srv/lib/export');

const {
  getS4ResultsQuery,
  getReviewQueueQuery,
  getCheckHistoryQuery,
  getActivityLogsQuery,
} = require('./srv/lib/pagination');

async function seedPostedIfEmpty() {
  const existing = await cds.run(SELECT.from('ap.Posted'));
  if (existing && existing.length > 0) return;

  const csvPath = path.join(__dirname, 'db/data/ap-Posted.csv');
  if (!fs.existsSync(csvPath)) return;
  const lines = fs.readFileSync(csvPath, 'utf8').trim().split('\n');
  if (lines.length < 2) return;
  const head = lines[0].split(',').map(s => s.trim());
  const U = require('./srv/rules/util');
  const masters = JSON.parse(fs.readFileSync(path.join(__dirname, 'data/masters.json'), 'utf8'));
  const entries = lines.slice(1).map(l => {
    const cells = l.split(',');
    const row = Object.fromEntries(head.map((h, i) => [h, cells[i] === '' ? null : cells[i]]));
    row.total = Number(row.total);
    row.blocked = row.blocked === 'true';
    row.recurringPo = row.recurringPo === 'true';
    row.fiscalYear = U.fiscalYear(row.invoiceDate);
    if (!row.supplierName && row.supplierGstin) {
      const v = (masters.vendors || []).find(x => x.gstin === row.supplierGstin);
      if (v) row.supplierName = v.name;
    }
    return row;
  });
  if (entries.length > 0) {
    await cds.run(INSERT.into('ap.Posted').entries(entries));
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
  return await cds.run(
    `SELECT * FROM ap_Checks ${whereSql} ORDER BY createdAt desc LIMIT ? OFFSET ?`,
    queryParams
  );
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
  return await cds.run(
    `SELECT * FROM ap_Checks ${whereSql} ORDER BY createdAt asc LIMIT ? OFFSET ?`,
    queryParams
  );
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
      filename: 'blus-invoice-agent-check-history.xlsx',
      sheetName: 'Check History',
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
    next();
  });

  // Serve static UI from /app, uploaded assets from /public/assets, and sample files from /samples
  app.use('/assets', express.static(path.join(__dirname, 'public/assets')));
  app.use('/public', express.static(path.join(__dirname, 'public')));
  app.use('/samples', express.static(path.join(__dirname, 'samples')));
  app.use(express.static(path.join(__dirname, 'app')));

  // Connect to DB and deploy schema
  cds.model = await cds.load(['db/schema.cds', 'srv/fraud-service.cds']);
  const db = await cds.connect.to('db');
  await cds.deploy(cds.model).to(db);
  try {
    await db.run('CREATE INDEX IF NOT EXISTS idx_posted_gstin_fy_inv ON ap_Posted (supplierGstin, fiscalYear, invoiceNo)');
    await db.run('CREATE INDEX IF NOT EXISTS idx_posted_gstin_amt_date ON ap_Posted (supplierGstin, total, invoiceDate)');
    await db.run('CREATE INDEX IF NOT EXISTS idx_checks_job_id ON ap_Checks (jobId)');
  } catch (err) {
    console.log('Index setup note:', err.message);
  }
  await seedPostedIfEmpty();

  // Background Job queue helpers and startup recovery
  const { getJob, cancelJob, resumeJob, markInterruptedJobsAsFailed } = require('./srv/lib/queue');
  await markInterruptedJobsAsFailed();

  // Streaming CSV and Excel (.xlsx) download endpoints
  app.get('/fraud/exportHistoryCsv', handleExportHistoryCsv);
  app.post('/fraud/exportHistoryCsv', handleExportHistoryCsv);
  app.get('/fraud/exportHistoryExcel', handleExportHistoryExcel);
  app.post('/fraud/exportHistoryExcel', handleExportHistoryExcel);

  app.get('/fraud/exportS4Csv', handleExportS4Csv);
  app.post('/fraud/exportS4Csv', handleExportS4Csv);
  app.get('/fraud/exportS4Excel', handleExportS4Excel);
  app.post('/fraud/exportS4Excel', handleExportS4Excel);

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

  // Batch documents endpoint for uploading multiple PDFs or images safely
  app.post('/fraud/uploadBatchDocuments', async (req, res) => {
    try {
      const rawFiles = typeof req.body.files === 'string' ? JSON.parse(req.body.files) : (req.body.files || req.body);
      const filesList = Array.isArray(rawFiles) ? rawFiles : (rawFiles && Array.isArray(rawFiles.files) ? rawFiles.files : []);
      if (!filesList.length) {
        return res.status(400).json({ error: { message: 'No files provided' } });
      }
      const { processDocumentBatch } = require('./srv/lib/document-processor');
      const { invoices, errors } = await processDocumentBatch(filesList);
      if (invoices.length > 2000) {
        return res.status(400).json({ error: { message: `This batch has ${invoices.length} invoices. The maximum per job is 2000. Please split the file.` } });
      }
      if (!invoices.length && errors.length) {
        return res.status(400).json({ error: { message: `Could not extract invoices: ${errors.map(e => e.fileName + ' (' + e.reason + ')').join('; ')}` } });
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
      return res.status(200).json({ ...jobInfo, invoicesCount: invoices.length, errors });
    } catch (err) {
      return res.status(400).json({ error: { message: err.message || 'Batch document processing failed' } });
    }
  });

  // OCR metrics route for inspecting concurrency limits
  app.get('/fraud/ocrMetrics', (req, res) => {
    const { getOcrMetrics } = require('./srv/lib/ocr');
    res.json(getOcrMetrics());
  });

  // Serve FraudService via CAP
  await cds.serve('FraudService').from('srv/fraud-service').in(app);

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Blus Invoice Agent listening on http://0.0.0.0:${PORT}`);
  });
}

main().catch(err => {
  console.error('Fatal error starting server:', err);
  process.exit(1);
});
