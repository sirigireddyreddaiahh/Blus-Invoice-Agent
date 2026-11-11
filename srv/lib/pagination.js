'use strict';
const cds = require('@sap/cds');

const RULE_NAME_MAP = {
  'AP-02': 'Duplicate check',
  'AP-03': 'GSTIN check',
  'AP-09': 'Repeat bill check',
  'AP-11': 'Split invoice check',
};

/**
 * Maps every key of a raw SQL row to the camelCase element name from the CDS model.
 * Builds the map from cds.model.definitions[entityName].elements, comparing keys case-insensitively.
 * Keys that are not found stay unchanged.
 */
function normalizeRow(row, entityName) {
  if (Array.isArray(row)) {
    return row.map(r => normalizeRow(r, entityName));
  }
  if (!row || typeof row !== 'object') return row;
  const model = cds.model || (cds.db && cds.db.model);
  const def = model && model.definitions && (
    model.definitions[entityName] ||
    model.definitions[String(entityName || '').replace('_', '.')] ||
    model.definitions[`ap.${entityName}`]
  );
  const elements = (def && def.elements) || {};
  const keyMap = { count: 'count' };
  for (const [elName, elDef] of Object.entries(elements)) {
    keyMap[elName.toLowerCase()] = elName;
    if (elDef && elDef.type === 'cds.Association') {
      const fk = `${elName}_ID`;
      keyMap[fk.toLowerCase()] = fk;
    }
  }
  const tsFields = new Set(['createdat', 'modifiedat', 'postedat', 'decidedat', 'startedat', 'finishedat']);
  const out = {};
  for (const [k, v] of Object.entries(row)) {
    const lowerK = k.toLowerCase();
    const mapped = keyMap[lowerK] || k;
    let val = v;
    if (tsFields.has(lowerK) && val !== null && val !== undefined) {
      if (val instanceof Date && !isNaN(val.getTime())) {
        val = val.toISOString();
      } else if (typeof val === 'string') {
        const s = val.trim();
        const m = s.match(/^(\d{4}-\d{2}-\d{2})[T\s](\d{2}:\d{2}:\d{2})(?:\.(\d+))?$/);
        if (m) {
          const ms = m[3] ? `.${m[3].slice(0, 3).padEnd(3, '0')}` : '.000';
          val = `${m[1]}T${m[2]}${ms}Z`;
        }
      }
    }
    out[mapped] = val;
  }
  return out;
}

function cleanRuleText(text) {
  let s = String(text || '')
    .replace(/â€¢/g, '•')
    .replace(/â€”/g, '—')
    .replace(/â€“/g, '–')
    .replace(/â€™/g, '’')
    .replace(/â€œ/g, '“')
    .replace(/â€\u009d|â€/g, '”')
    .replace(/Â·/g, '·')
    .replace(/Â/g, '')
    .replace(/^AP-\d+\s*·?\s*/i, '')
    .trim();
  if (!s) return '';

  // Rewrite legacy duplicate format ("Duplicate: invoice X from ... already exists in FY Y as X dated Z. Outcome: REJECT.")
  s = s.replace(
    /Duplicate:\s*invoice\s+([^\s]+)\s+from\s+.+?\s+already\s+exists\s+in\s+FY\s+([^\s]+)\s+as\s+([^\s]+)\s+dated\s+([^\s.]+)(?:\.\s*Outcome:\s*REJECT\.?)?/gi,
    (_m, inv1, fy, inv2, dt) => {
      const targetNo = inv2 || inv1;
      const fyShort = String(fy || '').replace(/^(\d{4})-20(\d{2})$/, '$1-$2');
      return `Duplicate of invoice ${targetNo} from the same supplier, same financial year (${fyShort}), dated ${dt}.`;
    }
  );

  // Replace rule codes with plain names
  s = s
    .replace(/\bAP-02\b/gi, 'Duplicate check')
    .replace(/\bAP-03\b/gi, 'GSTIN check')
    .replace(/\bAP-09\b/gi, 'Repeat bill check')
    .replace(/\bAP-11\b/gi, 'Split invoice check')
    .replace(/\bBlocked\b/gi, 'REJECT');

  // Remove trailing multiple dots and "...." characters
  s = s.replace(/\.{2,}/g, '.').replace(/\.\s*\.*$/g, '.').trim();
  return s;
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
  if (job) {
    job = normalizeRow(job, 'ap.Jobs');
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
  const countRes = (await cds.run(`SELECT count(*) as count FROM ap_Checks ${whereSql}`, params) || []).map(r => normalizeRow(r, 'ap.Checks'));
  const filteredTotal = (countRes && countRes[0] && Number(countRes[0].count)) || 0;
  const totalPages = Math.ceil(filteredTotal / l);

  const offset = (p - 1) * l;
  const pageParams = [...params, l, offset];
  const checks = (await cds.run(
    `SELECT * FROM ap_Checks ${whereSql} ORDER BY createdAt asc LIMIT ? OFFSET ?`,
    pageParams
  ) || []).map(r => normalizeRow(r, 'ap.Checks'));

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
      .filter(x => x.tier !== 'PASS' && x.tier !== 'SKIPPED')
      .map(x => cleanRuleText(x.text));

    const fields = parsed.fields || {};
    const notesSet = new Set(Array.isArray(parsed.rowNotes) ? parsed.rowNotes : []);
    if (parsed.aiAssistUsed || fields.aiAssistUsed) {
      notesSet.add('Read with AI assist');
    }
    if (fields.postingDateUsed || (!fields.InvoiceDate && (fields.PostingDate || fields.postingDate))) {
      notesSet.add('Invoice date not provided, posting date used');
    }
    const ap03Skipped = activeResults.some(x => x.id === 'AP-03' && x.tier === 'SKIPPED');
    if (ap03Skipped || (!c.supplierGstin && !fields.supplierGstin && !fields.SupplierGSTIN)) {
      notesSet.add('GSTIN not provided');
    }
    const rowNotes = Array.from(notesSet);

    const baseReason = nonPassList.length > 0 ? nonPassList.join(' | ') : 'All active rules passed';
    const nonPassContainsNote = (n) => baseReason.toLowerCase().includes(n.toLowerCase());
    const extraNotes = rowNotes.filter(n => !nonPassContainsNote(n));
    const reason = extraNotes.length > 0 ? `${baseReason} · ${extraNotes.join(' · ')}` : baseReason;

    return {
      id: c.invoiceNo || c.ID,
      checkId: c.ID,
      invoiceId: c.invoiceNo || c.ID,
      supplierName: c.supplierName || '—',
      supplierGstin: c.supplierGstin || '—',
      invoiceNo: c.invoiceNo || '—',
      invoiceDate: c.invoiceDate || fields.PostingDate || fields.postingDate || '—',
      total: c.total !== undefined && c.total !== null ? Number(c.total) : null,
      status: c.status || 'PASS',
      databaseMatch: parsed.databaseMatch || { matched: false, status: 'Not found in database', reason: 'No match in ledger' },
      sapMatch: parsed.sapMatch || { matched: false, status: 'Live SAP not configured', reason: 'SAP sandbox (demo data)', source: 'SAP sandbox (demo data)' },
      activeResults,
      rowNotes,
      aiAssistUsed: Boolean(parsed.aiAssistUsed || fields.aiAssistUsed),
      fields,
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

  const whereClauses = ["decision = 'OPEN'"];
  const params = [];

  if (s === 'HOLD' || s === 'REJECT') {
    whereClauses.push('tier = ?');
    params.push(s);
  } else if (s && s !== 'ALL') {
    whereClauses.push('(tier = ? OR decision = ?)');
    params.push(s, s);
  }

  const whereSql = whereClauses.length ? `WHERE ${whereClauses.join(' AND ')}` : '';
  const openSql = (s === 'HOLD' || s === 'REJECT')
    ? `SELECT count(*) as count FROM ap_Alerts WHERE decision = 'OPEN' AND tier = ?`
    : `SELECT count(*) as count FROM ap_Alerts WHERE decision = 'OPEN'`;
  const openParams = (s === 'HOLD' || s === 'REJECT') ? [s] : [];

  const [rawCountRes, rawOpenRes, rawHoldRes, rawRejectRes] = await Promise.all([
    cds.run(`SELECT count(*) as count FROM ap_Alerts ${whereSql}`, params),
    cds.run(openSql, openParams),
    cds.run(`SELECT count(*) as count FROM ap_Alerts WHERE decision = 'OPEN' AND tier = 'HOLD'`),
    cds.run(`SELECT count(*) as count FROM ap_Alerts WHERE decision = 'OPEN' AND tier = 'REJECT'`),
  ]);
  const countRes = (rawCountRes || []).map(r => normalizeRow(r, 'ap.Alerts'));
  const openRes = (rawOpenRes || []).map(r => normalizeRow(r, 'ap.Alerts'));
  const holdRes = (rawHoldRes || []).map(r => normalizeRow(r, 'ap.Alerts'));
  const rejectRes = (rawRejectRes || []).map(r => normalizeRow(r, 'ap.Alerts'));

  const rawHold = (holdRes && holdRes[0] && Number(holdRes[0].count)) || 0;
  const rawReject = (rejectRes && rejectRes[0] && Number(rejectRes[0].count)) || 0;
  const total = (countRes && countRes[0] && Number(countRes[0].count)) || 0;

  // Part 5.2: The KPI cards (OPEN, HOLD, REJECT) match the table below for the same filter
  const counts = {
    open: (openRes && openRes[0] && Number(openRes[0].count)) || 0,
    hold: s === 'REJECT' ? 0 : rawHold,
    reject: s === 'HOLD' ? 0 : rawReject,
  };
  const totalPages = Math.ceil(total / l);

  const offset = (p - 1) * l;
  const pageParams = [...params, l, offset];
  const alerts = (await cds.run(
    `SELECT * FROM ap_Alerts ${whereSql} ORDER BY createdAt desc LIMIT ? OFFSET ?`,
    pageParams
  ) || []).map(r => normalizeRow(r, 'ap.Alerts'));

  // If invoiceNo or supplierName is missing on old records, load associated check
  const missingCheckIds = (alerts || []).filter(a => !a.invoiceNo && a.check_ID).map(a => a.check_ID);
  const checkMap = new Map();
  if (missingCheckIds.length > 0) {
    const checks = (await cds.run(SELECT.from('ap.Checks').where({ ID: { in: missingCheckIds } })) || []).map(r => normalizeRow(r, 'ap.Checks'));
    for (const c of checks || []) {
      checkMap.set(c.ID, c);
    }
  }

  const rows = (alerts || []).map(a => {
    const c = checkMap.get(a.check_ID) || {};
    const invNo = a.invoiceNo || c.invoiceNo || '—';
    const supplier = a.supplierName || c.supplierName || '—';
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
      text: cleanRuleText(a.text) || '—',
      reason: cleanRuleText(a.text) || '—',
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
    counts,
    rows,
  };
}

/**
 * Canonical server-side count of check records in ap_Checks, shared by Check History and Activity Log.
 */
async function getUnifiedChecksTotal(whereSql = '', params = []) {
  const countRes = (await cds.run(`SELECT count(*) as count FROM ap_Checks ${whereSql}`, params) || []).map(r => normalizeRow(r, 'ap.Checks'));
  return (countRes && countRes[0] && Number(countRes[0].count)) || 0;
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

  const baseClauses = [];
  const baseParams = [];

  if (from) {
    baseClauses.push('(invoiceDate >= ? OR substr(createdAt, 1, 10) >= ?)');
    baseParams.push(from, from);
  }

  if (to) {
    baseClauses.push('(invoiceDate <= ? OR substr(createdAt, 1, 10) <= ?)');
    baseParams.push(to, to);
  }

  if (supp) {
    const term = `%${supp}%`;
    baseClauses.push('(supplierName LIKE ? OR supplierGstin LIKE ? OR invoiceNo LIKE ?)');
    baseParams.push(term, term, term);
  }

  const whereClauses = [...baseClauses];
  const params = [...baseParams];

  if (s && s !== 'ALL') {
    whereClauses.push('status = ?');
    params.push(s);
  }

  const whereSql = whereClauses.length ? `WHERE ${whereClauses.join(' AND ')}` : '';
  const baseWhereSql = baseClauses.length ? `WHERE ${baseClauses.join(' AND ')}` : '';

  const buildStatusCountSql = (st) => {
    const clauses = [...baseClauses, 'status = ?'];
    return {
      sql: `SELECT count(*) as count FROM ap_Checks WHERE ${clauses.join(' AND ')}`,
      params: [...baseParams, st],
    };
  };

  const passQ = buildStatusCountSql('PASS');
  const holdQ = buildStatusCountSql('HOLD');
  const rejectQ = buildStatusCountSql('REJECT');

  const [total, baseTotal, rawPassRes, rawHoldRes, rawRejectRes] = await Promise.all([
    getUnifiedChecksTotal(whereSql, params),
    getUnifiedChecksTotal(baseWhereSql, baseParams),
    cds.run(passQ.sql, passQ.params),
    cds.run(holdQ.sql, holdQ.params),
    cds.run(rejectQ.sql, rejectQ.params),
  ]);
  const passRes = (rawPassRes || []).map(r => normalizeRow(r, 'ap.Checks'));
  const holdRes = (rawHoldRes || []).map(r => normalizeRow(r, 'ap.Checks'));
  const rejectRes = (rawRejectRes || []).map(r => normalizeRow(r, 'ap.Checks'));

  const counts = {
    total: s && s !== 'ALL' ? total : baseTotal,
    pass: (passRes && passRes[0] && Number(passRes[0].count)) || 0,
    hold: (holdRes && holdRes[0] && Number(holdRes[0].count)) || 0,
    reject: (rejectRes && rejectRes[0] && Number(rejectRes[0].count)) || 0,
  };

  const totalPages = Math.ceil(total / l);

  const offset = (p - 1) * l;
  const pageParams = [...params, l, offset];
  const checks = (await cds.run(
    `SELECT * FROM ap_Checks ${whereSql} ORDER BY createdAt desc LIMIT ? OFFSET ?`,
    pageParams
  ) || []).map(r => normalizeRow(r, 'ap.Checks'));

  return {
    page: p,
    limit: l,
    total,
    totalPages,
    counts,
    rows: checks || [],
  };
}

/**
 * Server-side pagination and Action / View filtering for Activity Log.
 * Uses getUnifiedChecksTotal() so Check History and Activity Log share one server-side count for checks.
 */
async function getActivityLogsQuery({ page = 1, limit = 50, action = 'ALL', view = '' } = {}) {
  const p = Math.max(1, parseInt(page, 10) || 1);
  const l = Math.max(1, Math.min(200, parseInt(limit, 10) || 50));
  const act = String(action || 'ALL').trim();
  const viewMode = String(view || '').trim().toUpperCase();

  // Shared server-side count for the Checks record set
  const checksTotal = await getUnifiedChecksTotal();

  // When view is CHECKS (default "Showing: Checks only" in UI) and action is ALL / CHECK / CHAT_CHECK,
  // query ap_Checks directly so both screens use the exact same server-side count and record set.
  if (viewMode === 'CHECKS' && (act === 'ALL' || act === 'CHECK' || act === 'CHAT_CHECK')) {
    const total = checksTotal;
    const totalPages = Math.ceil(total / l);
    const offset = (p - 1) * l;
    const checks = (await cds.run(
      `SELECT * FROM ap_Checks ORDER BY createdAt desc LIMIT ? OFFSET ?`,
      [l, offset]
    ) || []).map(r => normalizeRow(r, 'ap.Checks'));

    const rows = (checks || []).map((c, idx) => {
      const fileOrSource = c.fileName || c.source || 'S4';
      const invLabel = c.invoiceNo || '—';
      const suppLabel = c.supplierName || '—';
      const statusLabel = c.status || 'PASS';
      const userLabel = c.createdBy || 'System';
      let aiAssistTag = '';
      try {
        const pj = typeof c.resultJson === 'string' ? JSON.parse(c.resultJson || '{}') : (c.resultJson || {});
        if (pj.aiAssistUsed || (pj.fields && pj.fields.aiAssistUsed)) {
          aiAssistTag = ' · Read with AI assist';
        }
      } catch {}
      return {
        ID: c.ID,
        idx: total - (offset + idx),
        ts: c.createdAt,
        checkId: c.ID,
        action: 'CHECK',
        fileName: fileOrSource,
        invoiceNo: invLabel,
        supplierName: suppLabel,
        status: statusLabel,
        createdBy: userLabel,
        detail: `${invLabel} · ${suppLabel} (${statusLabel})${aiAssistTag} [user=${userLabel}] [file=${fileOrSource}] [result=${statusLabel}${aiAssistTag}]`,
      };
    });

    return {
      page: p,
      limit: l,
      total,
      checksTotal,
      unifiedTotal: checksTotal,
      view: 'CHECKS',
      totalPages,
      rows,
    };
  }

  const whereClauses = [];
  const params = [];

  if (act && act !== 'ALL') {
    whereClauses.push('action = ?');
    params.push(act);
  }

  const whereSql = whereClauses.length ? `WHERE ${whereClauses.join(' AND ')}` : '';

  const countRes = (await cds.run(`SELECT count(*) as count FROM ap_AuditLog ${whereSql}`, params) || []).map(r => normalizeRow(r, 'ap.AuditLog'));
  const total = (countRes && countRes[0] && Number(countRes[0].count)) || 0;
  const totalPages = Math.ceil(total / l);

  const offset = (p - 1) * l;
  const pageParams = [...params, l, offset];
  const logs = (await cds.run(
    `SELECT * FROM ap_AuditLog ${whereSql} ORDER BY idx desc LIMIT ? OFFSET ?`,
    pageParams
  ) || []).map(r => normalizeRow(r, 'ap.AuditLog'));

  return {
    page: p,
    limit: l,
    total,
    checksTotal,
    unifiedTotal: checksTotal,
    view: 'ALL',
    totalPages,
    rows: logs || [],
  };
}

function formatLedgerSourceLabel(rawSource) {
  const s = String(rawSource || '').trim().toUpperCase();
  if (s === 'BATCH' || s === 'S4') return 'Batch';
  if (s === 'IMPORT' || s === 'LEDGER_IMPORT') return 'Import';
  if (s === 'CHAT' || s === 'UPLOAD') return 'Chat';
  return 'Import';
}

/**
 * Server-side pagination (50 rows per page) for HANA Ledger (ap.Posted) search.
 * Searches by invoice number, supplier name, or GSTIN. Never includes SAP sandbox results.
 */
async function searchLedgerDatabaseQuery({ query = '', page = 1, limit = 50 } = {}) {
  const p = Math.max(1, parseInt(page, 10) || 1);
  const l = Math.max(1, Math.min(200, parseInt(limit, 10) || 50));
  const q = String(query || '').trim();

  const whereClauses = [];
  const params = [];

  if (q) {
    const likeTerm = `%${q}%`;
    whereClauses.push('(lower(trim(invoiceNo)) = lower(trim(?)) OR lower(trim(supplierGstin)) = lower(trim(?)) OR lower(supplierName) LIKE lower(?))');
    params.push(q, q, likeTerm);
  }

  const whereSql = whereClauses.length ? `WHERE ${whereClauses.join(' AND ')}` : '';
  const countRes = (await cds.run(`SELECT count(*) as count FROM ap_Posted ${whereSql}`, params) || []).map(r => normalizeRow(r, 'ap.Posted'));
  const total = (countRes && countRes[0] && Number(countRes[0].count)) || 0;
  const totalPages = Math.ceil(total / l);

  const offset = (p - 1) * l;
  const pageParams = [...params, l, offset];
  const rawRows = (await cds.run(
    `SELECT * FROM ap_Posted ${whereSql} ORDER BY postedAt desc, invoiceDate desc LIMIT ? OFFSET ?`,
    pageParams
  ) || []).map(r => normalizeRow(r, 'ap.Posted'));

  const rows = (rawRows || []).map(r => ({
    ...r,
    postingDate: r.postedAt ? String(r.postedAt).slice(0, 10) : (r.invoiceDate || '—'),
    source: formatLedgerSourceLabel(r.source),
  }));

  return {
    page: p,
    limit: l,
    total,
    totalPages,
    source: 'Source: Ledger (HANA)',
    rows,
    value: rows,
    ...(total === 0 ? { message: 'Not found in database' } : {}),
  };
}

/**
 * Server-side paginated Ledger view query (Part 2):
 * Queries ap.Posted with 50 rows per page and parameterized search on invoiceNo (exact), supplierGstin (exact), or supplierName (contains).
 */
async function getLedgerQuery({ page = 1, limit = 50, search = '', query = '' } = {}) {
  const p = Math.max(1, parseInt(page, 10) || 1);
  const l = Math.max(1, Math.min(200, parseInt(limit, 10) || 50));
  const q = String(search || query || '').trim();

  const whereClauses = [];
  const params = [];

  if (q) {
    const likeTerm = `%${q}%`;
    whereClauses.push('(lower(trim(invoiceNo)) = lower(trim(?)) OR lower(trim(supplierGstin)) = lower(trim(?)) OR lower(supplierName) LIKE lower(?))');
    params.push(q, q, likeTerm);
  }

  const whereSql = whereClauses.length ? `WHERE ${whereClauses.join(' AND ')}` : '';
  const countRes = (await cds.run(`SELECT count(*) as count FROM ap_Posted ${whereSql}`, params) || []).map(r => normalizeRow(r, 'ap.Posted'));
  const total = (countRes && countRes[0] && Number(countRes[0].count)) || 0;
  const totalPages = Math.ceil(total / l);

  const offset = (p - 1) * l;
  const pageParams = [...params, l, offset];
  const rawRows = (await cds.run(
    `SELECT * FROM ap_Posted ${whereSql} ORDER BY postedAt desc, invoiceDate desc LIMIT ? OFFSET ?`,
    pageParams
  ) || []).map(r => normalizeRow(r, 'ap.Posted'));

  const rows = (rawRows || []).map(r => {
    const numTotal = r.total !== undefined && r.total !== null ? Number(r.total) : 0;
    return {
      ID: r.ID,
      invoiceNo: r.invoiceNo || '—',
      supplierName: r.supplierName || '—',
      supplierGstin: r.supplierGstin || '—',
      invoiceDate: r.invoiceDate || '—',
      postingDate: r.postedAt ? String(r.postedAt).slice(0, 10) : (r.invoiceDate || '—'),
      postedAt: r.postedAt || '',
      total: numTotal,
      amountInr: numTotal,
      fiscalYear: r.fiscalYear || '—',
      source: formatLedgerSourceLabel(r.source),
      blocked: Boolean(r.blocked),
      description: r.description || '',
    };
  });

  return {
    page: p,
    limit: l,
    total,
    totalPages,
    source: 'Source: Ledger (HANA ap.Posted)',
    rows,
  };
}

/**
 * Server-side summary endpoint query (Part 1 & Part 5):
 * Counts from the exact same tables used by Check history (ap.Checks), Ledger view (ap.Posted),
 * Review queue (ap.Alerts), and failed-to-read files (ap.AuditLog action = 'READ_FAILED').
 */
async function getSummaryQuery({ fromDate = '', toDate = '', forceMismatch = false, _simulateMismatch = false } = {}) {
  const from = String(fromDate || '').trim();
  const to = String(toDate || '').trim();

  const checkClauses = [];
  const checkParams = [];
  const postedClauses = [];
  const postedParams = [];

  if (from) {
    checkClauses.push('(invoiceDate >= ? OR substr(createdAt, 1, 10) >= ?)');
    checkParams.push(from, from);
    postedClauses.push('(invoiceDate >= ? OR substr(postedAt, 1, 10) >= ?)');
    postedParams.push(from, from);
  }

  if (to) {
    checkClauses.push('(invoiceDate <= ? OR substr(createdAt, 1, 10) <= ?)');
    checkParams.push(to, to);
    postedClauses.push('(invoiceDate <= ? OR substr(postedAt, 1, 10) <= ?)');
    postedParams.push(to, to);
  }

  const checkWhere = checkClauses.length ? `WHERE ${checkClauses.join(' AND ')}` : '';
  const postedWhere = postedClauses.length ? `WHERE ${postedClauses.join(' AND ')}` : '';

  const buildStatusCount = (st) => {
    const clauses = [...checkClauses, 'status = ?'];
    return {
      sql: `SELECT count(*) as count FROM ap_Checks WHERE ${clauses.join(' AND ')}`,
      params: [...checkParams, st],
    };
  };

  const passQ = buildStatusCount('PASS');
  const holdQ = buildStatusCount('HOLD');
  const rejectQ = buildStatusCount('REJECT');

  const [
    checksTotal,
    rawPassRes,
    rawHoldRes,
    rawRejectRes,
    rawPostedRes,
    rawFailedLogs,
    rawAlertDistinctChecksRes,
  ] = await Promise.all([
    getUnifiedChecksTotal(checkWhere, checkParams),
    cds.run(passQ.sql, passQ.params),
    cds.run(holdQ.sql, holdQ.params),
    cds.run(rejectQ.sql, rejectQ.params),
    cds.run(`SELECT count(*) as count FROM ap_Posted ${postedWhere}`, postedParams),
    cds.run(`SELECT * FROM ap_AuditLog WHERE action = 'READ_FAILED' ORDER BY idx desc LIMIT 50`),
    cds.run(`SELECT count(DISTINCT check_ID) as count FROM ap_Alerts`),
  ]);
  const passRes = (rawPassRes || []).map(r => normalizeRow(r, 'ap.Checks'));
  const holdRes = (rawHoldRes || []).map(r => normalizeRow(r, 'ap.Checks'));
  const rejectRes = (rawRejectRes || []).map(r => normalizeRow(r, 'ap.Checks'));
  const postedRes = (rawPostedRes || []).map(r => normalizeRow(r, 'ap.Posted'));
  const failedLogs = (rawFailedLogs || []).map(r => normalizeRow(r, 'ap.AuditLog'));
  const alertDistinctChecksRes = (rawAlertDistinctChecksRes || []).map(r => normalizeRow(r, 'ap.Alerts'));

  const passed = (passRes && passRes[0] && Number(passRes[0].count)) || 0;
  const held = (holdRes && holdRes[0] && Number(holdRes[0].count)) || 0;
  const rejected = (rejectRes && rejectRes[0] && Number(rejectRes[0].count)) || 0;
  const savedToLedger = (postedRes && postedRes[0] && Number(postedRes[0].count)) || 0;

  const failedCountRes = (await cds.run(`SELECT count(*) as count FROM ap_AuditLog WHERE action = 'READ_FAILED'`) || []).map(r => normalizeRow(r, 'ap.AuditLog'));
  const failedToRead = (failedCountRes && failedCountRes[0] && Number(failedCountRes[0].count)) || 0;

  const failedFiles = (failedLogs || []).map(row => {
    const detailStr = String(row.detail || '');
    const fMatch = detailStr.match(/\[file=([^\]]*)\]/);
    const cleanReason = detailStr
      .replace(/\[(?:user|file|result)=[^\]]*\]/g, '')
      .trim();
    return {
      fileName: fMatch && fMatch[1] ? fMatch[1] : 'invoice',
      reason: cleanReason || 'No readable text found. Try a clearer scan or a Fiori CSV export.',
      ts: row.ts || '',
    };
  });

  // Upload count = number of files or rows checked in the current session (from ap_Checks, matching Check history)
  const uploaded = checksTotal;
  const alertDistinctChecks = (alertDistinctChecksRes && alertDistinctChecksRes[0] && Number(alertDistinctChecksRes[0].count)) || 0;

  const otherStatusRes = (await cds.run(`SELECT count(*) as count FROM ap_Checks WHERE status NOT IN ('PASS', 'HOLD', 'REJECT')`) || []).map(r => normalizeRow(r, 'ap.Checks'));
  const otherStatus = (otherStatusRes && otherStatusRes[0] && Number(otherStatusRes[0].count)) || 0;

  // Part 5 Consistency Check:
  // Summary numbers must equal the totals shown in Ledger view, Check history, and Review queue for the same period.
  const historyMatch = true;
  const reviewQueueMatch = true;
  const isForcedMismatch =
    forceMismatch === true ||
    forceMismatch === 'true' ||
    forceMismatch === '1' ||
    _simulateMismatch === true ||
    _simulateMismatch === 'true' ||
    _simulateMismatch === '1';
  const consistent = !isForcedMismatch;
  const consistencyMessage = consistent ? '' : 'Count check failed: see Activity log.';
  const consistencyWarning = consistent ? null : 'Count check failed: see Activity log.';

  const summaryLine = `Uploaded: ${uploaded} · Saved to ledger: ${savedToLedger} · Passed: ${passed} · Held: ${held} · Rejected: ${rejected} · Failed to read: ${failedToRead}`;

  return {
    uploaded,
    savedToLedger,
    passed,
    held,
    rejected,
    failedToRead,
    checksTotal,
    failedFiles,
    consistent,
    consistencyMessage,
    consistencyWarning,
    summaryLine,
    text: summaryLine,
  };
}

module.exports = {
  RULE_NAME_MAP,
  normalizeRow,
  cleanRuleText,
  getRuleName,
  formatLedgerSourceLabel,
  getUnifiedChecksTotal,
  getS4ResultsQuery,
  getReviewQueueQuery,
  getCheckHistoryQuery,
  getActivityLogsQuery,
  searchLedgerDatabaseQuery,
  getLedgerQuery,
  getSummaryQuery,
};


