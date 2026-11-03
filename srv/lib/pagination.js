'use strict';
const cds = require('@sap/cds');

const RULE_NAME_MAP = {
  'AP-02': 'Duplicate invoice',
  'AP-03': 'GSTIN multi-vendor reuse',
  'AP-09': 'Repeat service bill',
  'AP-11': 'Split invoice pattern',
};

function cleanRuleText(text) {
  return String(text || '').replace(/^AP-\d+\s*·?\s*/i, '').trim();
}

function getRuleName(ruleId) {
  return RULE_NAME_MAP[ruleId] || cleanRuleText(ruleId) || 'Invoice rule check';
}

/**
 * Server-side pagination, status filtering, and search for S/4HANA extract results.
 */
async function getS4ResultsQuery({ jobId = '', page = 1, limit = 50, status = 'ALL', search = '' } = {}) {
  const p = Math.max(1, parseInt(page, 10) || 1);
  const l = Math.max(1, Math.min(200, parseInt(limit, 10) || 50));
  const s = String(status || 'ALL').trim().toUpperCase();
  const q = String(search || '').trim();

  let job = null;
  if (jobId && jobId !== 'latest') {
    job = await cds.run(
      SELECT.one.from('ap.Jobs').where({ ID: jobId }).or({ jobId })
    );
  }
  if (!job) {
    job = await cds.run(
      SELECT.one.from('ap.Jobs').orderBy('createdAt desc')
    );
  }

  const counts = {
    total: job ? (job.total || 0) : 0,
    pass: job ? (job.passCount || 0) : 0,
    hold: job ? (job.holdCount || 0) : 0,
    reject: job ? (job.rejectCount || 0) : 0,
  };

  if (!job) {
    return {
      jobId: null,
      jobStatus: null,
      page: p,
      limit: l,
      total: 0,
      filteredTotal: 0,
      totalPages: 0,
      counts,
      rows: [],
    };
  }

  const targetJobId = job.jobId || job.ID;
  const whereClauses = [];
  const params = [];

  // Match checks by jobId (or fallback to source if no jobId)
  if (targetJobId) {
    whereClauses.push('jobId = ?');
    params.push(targetJobId);
  } else {
    whereClauses.push("source = 'S4'");
  }

  if (s && s !== 'ALL') {
    whereClauses.push('status = ?');
    params.push(s);
  }

  if (q) {
    const term = `%${q}%`;
    whereClauses.push('(invoiceNo LIKE ? OR supplierName LIKE ? OR supplierGstin LIKE ?)');
    params.push(term, term, term);
  }

  const whereSql = whereClauses.length ? `WHERE ${whereClauses.join(' AND ')}` : '';

  // Total matching rows for this filter
  const countRes = await cds.run(`SELECT count(*) as count FROM ap_Checks ${whereSql}`, params);
  const filteredTotal = (countRes && countRes[0] && Number(countRes[0].count)) || 0;
  const totalPages = Math.ceil(filteredTotal / l);

  const offset = (p - 1) * l;
  const pageParams = [...params, l, offset];
  const checks = await cds.run(
    `SELECT * FROM ap_Checks ${whereSql} ORDER BY createdAt asc LIMIT ? OFFSET ?`,
    pageParams
  );

  const rows = (checks || []).map(c => {
    let parsed = {};
    try {
      parsed = typeof c.resultJson === 'string' ? JSON.parse(c.resultJson || '{}') : (c.resultJson || {});
    } catch {}

    const results = Array.isArray(parsed.results) ? parsed.results : [];
    const activeResults = (parsed.activeResults && parsed.activeResults.length)
      ? parsed.activeResults
      : results.filter(x => ['AP-02', 'AP-03', 'AP-09', 'AP-11'].includes(x.id));

    const nonPassList = activeResults
      .filter(x => x.tier !== 'PASS')
      .map(x => cleanRuleText(x.text));
    const reason = nonPassList.length > 0 ? nonPassList.join(' | ') : 'All active rules passed';

    return {
      id: c.invoiceNo || c.ID,
      checkId: c.ID,
      invoiceId: c.invoiceNo || c.ID,
      supplierName: c.supplierName || '-',
      supplierGstin: c.supplierGstin || '-',
      invoiceNo: c.invoiceNo || '-',
      invoiceDate: c.invoiceDate || '-',
      total: c.total !== undefined && c.total !== null ? Number(c.total) : null,
      status: c.status || 'PASS',
      databaseMatch: parsed.databaseMatch || { matched: false, status: 'Not found in database', reason: 'No match in ledger' },
      activeResults,
      reason,
    };
  });

  return {
    jobId: targetJobId,
    jobStatus: job.status,
    page: p,
    limit: l,
    total: filteredTotal,
    jobTotal: job.total || 0,
    filteredTotal,
    totalPages,
    counts,
    rows,
  };
}

/**
 * Server-side pagination and filtering for Review Queue.
 */
async function getReviewQueueQuery({ page = 1, limit = 50, status = 'ALL' } = {}) {
  const p = Math.max(1, parseInt(page, 10) || 1);
  const l = Math.max(1, Math.min(200, parseInt(limit, 10) || 50));
  const s = String(status || 'ALL').trim().toUpperCase();

  const whereClauses = [];
  const params = [];

  if (s && s !== 'ALL') {
    whereClauses.push('(tier = ? OR decision = ?)');
    params.push(s, s);
  }

  const whereSql = whereClauses.length ? `WHERE ${whereClauses.join(' AND ')}` : '';

  const countRes = await cds.run(`SELECT count(*) as count FROM ap_Alerts ${whereSql}`, params);
  const total = (countRes && countRes[0] && Number(countRes[0].count)) || 0;
  const totalPages = Math.ceil(total / l);

  const offset = (p - 1) * l;
  const pageParams = [...params, l, offset];
  const alerts = await cds.run(
    `SELECT * FROM ap_Alerts ${whereSql} ORDER BY createdAt desc LIMIT ? OFFSET ?`,
    pageParams
  );

  // If invoiceNo or supplierName is missing on old records, load associated check
  const missingCheckIds = (alerts || []).filter(a => !a.invoiceNo && a.check_ID).map(a => a.check_ID);
  const checkMap = new Map();
  if (missingCheckIds.length > 0) {
    const checks = await cds.run(SELECT.from('ap.Checks').where({ ID: { in: missingCheckIds } }));
    for (const c of checks || []) {
      checkMap.set(c.ID, c);
    }
  }

  const rows = (alerts || []).map(a => {
    const c = checkMap.get(a.check_ID) || {};
    const invNo = a.invoiceNo || c.invoiceNo || '-';
    const supplier = a.supplierName || c.supplierName || '-';
    const ruleName = getRuleName(a.ruleId);

    return {
      ID: a.ID,
      check_ID: a.check_ID,
      issue: ruleName,
      ruleName: ruleName,
      ruleId: a.ruleId,
      invoiceNo: invNo,
      supplierName: supplier,
      title: cleanRuleText(a.title) || ruleName,
      text: cleanRuleText(a.text) || '-',
      reason: cleanRuleText(a.text) || '-',
      tier: a.tier || 'HOLD',
      decision: a.decision || 'OPEN',
      comment: a.comment || '',
      decidedBy: a.decidedBy || '',
      decidedAt: a.decidedAt || '',
      createdAt: a.createdAt || '',
    };
  });

  return {
    page: p,
    limit: l,
    total,
    totalPages,
    rows,
  };
}

/**
 * Server-side pagination and filtering for Check History.
 */
async function getCheckHistoryQuery({ page = 1, limit = 50, status = 'ALL', fromDate = '', toDate = '', supplier = '' } = {}) {
  const p = Math.max(1, parseInt(page, 10) || 1);
  const l = Math.max(1, Math.min(200, parseInt(limit, 10) || 50));
  const s = String(status || 'ALL').trim().toUpperCase();
  const from = String(fromDate || '').trim();
  const to = String(toDate || '').trim();
  const supp = String(supplier || '').trim();

  const whereClauses = [];
  const params = [];

  if (s && s !== 'ALL') {
    whereClauses.push('status = ?');
    params.push(s);
  }

  if (from) {
    whereClauses.push('(invoiceDate >= ? OR substr(createdAt, 1, 10) >= ?)');
    params.push(from, from);
  }

  if (to) {
    whereClauses.push('(invoiceDate <= ? OR substr(createdAt, 1, 10) <= ?)');
    params.push(to, to);
  }

  if (supp) {
    const term = `%${supp}%`;
    whereClauses.push('(supplierName LIKE ? OR supplierGstin LIKE ? OR invoiceNo LIKE ?)');
    params.push(term, term, term);
  }

  const whereSql = whereClauses.length ? `WHERE ${whereClauses.join(' AND ')}` : '';

  const countRes = await cds.run(`SELECT count(*) as count FROM ap_Checks ${whereSql}`, params);
  const total = (countRes && countRes[0] && Number(countRes[0].count)) || 0;
  const totalPages = Math.ceil(total / l);

  const offset = (p - 1) * l;
  const pageParams = [...params, l, offset];
  const checks = await cds.run(
    `SELECT * FROM ap_Checks ${whereSql} ORDER BY createdAt desc LIMIT ? OFFSET ?`,
    pageParams
  );

  return {
    page: p,
    limit: l,
    total,
    totalPages,
    rows: checks || [],
  };
}

/**
 * Server-side pagination and Action filtering for Activity Log.
 */
async function getActivityLogsQuery({ page = 1, limit = 50, action = 'ALL' } = {}) {
  const p = Math.max(1, parseInt(page, 10) || 1);
  const l = Math.max(1, Math.min(200, parseInt(limit, 10) || 50));
  const act = String(action || 'ALL').trim();

  const whereClauses = [];
  const params = [];

  if (act && act !== 'ALL') {
    whereClauses.push('action = ?');
    params.push(act);
  }

  const whereSql = whereClauses.length ? `WHERE ${whereClauses.join(' AND ')}` : '';

  const countRes = await cds.run(`SELECT count(*) as count FROM ap_AuditLog ${whereSql}`, params);
  const total = (countRes && countRes[0] && Number(countRes[0].count)) || 0;
  const totalPages = Math.ceil(total / l);

  const offset = (p - 1) * l;
  const pageParams = [...params, l, offset];
  const logs = await cds.run(
    `SELECT * FROM ap_AuditLog ${whereSql} ORDER BY idx desc LIMIT ? OFFSET ?`,
    pageParams
  );

  return {
    page: p,
    limit: l,
    total,
    totalPages,
    rows: logs || [],
  };
}

module.exports = {
  RULE_NAME_MAP,
  cleanRuleText,
  getRuleName,
  getS4ResultsQuery,
  getReviewQueueQuery,
  getCheckHistoryQuery,
  getActivityLogsQuery,
};
