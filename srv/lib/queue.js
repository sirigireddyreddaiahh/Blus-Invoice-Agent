'use strict';
const cds = require('@sap/cds');
const crypto = require('crypto');
const { runRules } = require('../rules/engine');
const {
  loadLedgerForInvoices,
  findDatabaseMatch,
  insertInvoiceIntoLedger,
} = require('./ledger');
const { checkSapMatchForInvoice, querySapSandboxInvoices, getSapConfig } = require('./sap');
const { normalizeRow } = require('./pagination');

const CHUNK_SIZE = 50;

const jobQueue = [];
let isWorkerRunning = false;
const cancelledJobIds = new Set();
const liveJobProgress = new Map();

function publicView(inv) {
  const { pdfText: _text, ...rest } = inv;
  return rest;
}

function enrichRuleResult(r) {
  const activeResults = (r.results || []).filter(x => ['AP-02', 'AP-03', 'AP-09', 'AP-11'].includes(x.id));
  const hasReject = r.status === 'REJECT' || activeResults.some(x => x.tier === 'REJECT');
  const hasHold = r.status === 'HOLD' || activeResults.some(x => x.tier === 'HOLD');
  const verdict = hasReject ? 'Blocked' : (hasHold ? 'Needs review' : 'Passed checks');
  return {
    ...r,
    verdict,
    activeResults,
  };
}

async function markInterruptedJobsAsFailed() {
  try {
    const running = await cds.run(SELECT.from('ap.Jobs').where({ status: 'RUNNING' }));
    if (running && running.length > 0) {
      await cds.run(
        UPDATE('ap.Jobs')
          .set({
            status: 'FAILED',
            error: 'Server interrupted or restarted while job was running',
            finishedAt: new Date().toISOString(),
          })
          .where({ status: 'RUNNING' })
      );
      console.log(`[QUEUE_STARTUP] Marked ${running.length} interrupted RUNNING jobs as FAILED.`);
    }
  } catch (err) {
    console.error('[QUEUE_STARTUP_ERROR]', err.message);
  }
}

async function triggerWorker() {
  if (isWorkerRunning) return;
  if (!jobQueue.length) return;

  isWorkerRunning = true;
  const currentJob = jobQueue.shift();

  try {
    await processJob(currentJob);
  } catch (err) {
    console.error(`[QUEUE_JOB_ERROR] Job ${currentJob.jobId} failed:`, err);
    try {
      const now = new Date().toISOString();
      await cds.run(
        UPDATE('ap.Jobs').set({
          status: 'FAILED',
          error: String(err.message || err).slice(0, 500),
          finishedAt: now,
        }).where({ ID: currentJob.jobId })
      );
      if (typeof currentJob.audit === 'function') {
        await currentJob.audit(
          'BATCH_JOB',
          null,
          `Batch job failed: ${err.message}`,
          { user: currentJob.user, fileName: 'batch-job', result: 'FAILED' }
        );
      }
    } catch (e) {
      console.error('[QUEUE_JOB_CLEANUP_ERROR]', e);
    }
  } finally {
    isWorkerRunning = false;
    if (jobQueue.length > 0) {
      setImmediate(() => triggerWorker());
    }
  }
}

async function processJob(task) {
  const {
    jobId,
    invoices,
    user,
    source,
    masters,
    audit,
    startingIndex = 0,
    initialResults = [],
    initialErrors = [],
    initialPassCount = 0,
    initialHoldCount = 0,
    initialRejectCount = 0,
  } = task;

  const startTime = Date.now();
  const startedAt = new Date().toISOString();

  // If already cancelled before picking up from queue
  if (cancelledJobIds.has(jobId)) {
    cancelledJobIds.delete(jobId);
    await cds.run(
      UPDATE('ap.Jobs').set({
        status: 'CANCELLED',
        finishedAt: startedAt,
      }).where({ ID: jobId })
    );
    if (typeof audit === 'function') {
      await audit(
        'BATCH_JOB',
        null,
        `Batch job ${jobId} cancelled before start.`,
        { user, fileName: 'batch-job', result: 'CANCELLED' }
      );
    }
    return;
  }

  // Mark job as RUNNING in database
  await cds.run(
    UPDATE('ap.Jobs').set({
      status: 'RUNNING',
      startedAt,
      error: null,
    }).where({ ID: jobId })
  );

  const total = invoices.length;

  const rawJobRow = await cds.run(
    SELECT.one.from('ap.Jobs').where({ ID: jobId }).or({ jobId })
  );
  const jobRow = rawJobRow ? normalizeRow(rawJobRow, 'ap.Jobs') : null;
  const actualStartingIndex = Number((jobRow && (jobRow.lastIndex || jobRow.processed)) || startingIndex || 0);

  if (actualStartingIndex >= total && total > 0) {
    await cds.run(
      UPDATE('ap.Jobs').set({
        status: 'DONE',
        processed: total,
        finishedAt: new Date().toISOString(),
      }).where({ ID: jobId })
    );
    return;
  }

  if (typeof audit === 'function') {
    const isResume = Boolean(task.isResume || actualStartingIndex > 0);
    await audit(
      'BATCH_JOB',
      null,
      isResume
        ? `Batch job ${jobId} resumed from invoice ${actualStartingIndex + 1} of ${total}`
        : `Batch job started: ${total} invoices queued (Job ID: ${jobId})`,
      { user, fileName: 'batch-job', result: isResume ? 'RESUMED' : 'STARTED' }
    );
  }

  // Lightweight in-memory tracking across chunks to detect intra-batch duplicates
  const lightweightEarlier = [];
  // Populate lightweight keys from previously completed items
  for (let i = 0; i < actualStartingIndex && i < invoices.length; i++) {
    const inv = invoices[i];
    lightweightEarlier.push({
      id: inv.id,
      invoiceNo: inv.invoiceNo,
      supplierGstin: inv.supplierGstin,
      supplierName: inv.supplierName,
      invoiceDate: inv.invoiceDate,
      total: inv.total,
      description: inv.description,
      irn: inv.irn,
    });
  }

  let allPublicResults = [...initialResults];
  if (jobRow && jobRow.resultJson && actualStartingIndex > 0) {
    try { allPublicResults = JSON.parse(jobRow.resultJson); } catch {}
  }
  let jobErrors = [...initialErrors];
  if (jobRow && jobRow.errorsJson && actualStartingIndex > 0) {
    try { jobErrors = JSON.parse(jobRow.errorsJson); } catch {}
  }

  let totalProcessed = actualStartingIndex;
  let passCount = Number((jobRow && jobRow.passCount) || initialPassCount || 0);
  let holdCount = Number((jobRow && jobRow.holdCount) || initialHoldCount || 0);
  let rejectCount = Number((jobRow && jobRow.rejectCount) || initialRejectCount || 0);

  const sapCache = new Map();
  let sapCircuitBroken = false;
  const prefetchedSapRes =
    total > 5 && getSapConfig().isConfigured
      ? await querySapSandboxInvoices({ top: 50, timeoutMs: 5000 })
      : null;

  // Process chunk by chunk starting from actualStartingIndex
  for (let cStart = actualStartingIndex; cStart < total; cStart += CHUNK_SIZE) {
    // Check if job was cancelled while running
    if (cancelledJobIds.has(jobId)) {
      cancelledJobIds.delete(jobId);
      const finishedAt = new Date().toISOString();
      await cds.run(
        UPDATE('ap.Jobs').set({
          status: 'CANCELLED',
          processed: totalProcessed,
          lastIndex: totalProcessed,
          passCount,
          holdCount,
          rejectCount,
          finishedAt,
          resultJson: JSON.stringify(allPublicResults),
          errorsJson: JSON.stringify(jobErrors),
        }).where({ ID: jobId })
      );
      if (typeof audit === 'function') {
        await audit(
          'BATCH_JOB',
          null,
          `Batch job ${jobId} cancelled. ${totalProcessed} of ${total} invoices processed.`,
          { user, fileName: 'batch-job', result: 'CANCELLED' }
        );
      }
      return;
    }

    const chunkInvoices = invoices.slice(cStart, Math.min(cStart + CHUNK_SIZE, total));

    // Indexed lookup for ledger records matching only GSTINs present in this chunk
    const posted = await loadLedgerForInvoices(chunkInvoices);

    const checksToInsert = [];
    const resultsToInsert = [];
    const alertsToInsert = [];

    for (let i = 0; i < chunkInvoices.length; i++) {
      const inv = chunkInvoices[i];
      const currentIdx = cStart + i + 1;

      liveJobProgress.set(jobId, {
        status: 'RUNNING',
        processed: currentIdx - 1,
        currentIndex: currentIdx,
        total,
        passCount,
        holdCount,
        rejectCount,
        currentInvoiceNo: inv.invoiceNo || inv.SupplierInvoice || `Row ${currentIdx}`,
        currentSupplier: inv.supplierName || inv.InvoicingParty || 'Supplier',
        currentFileName: inv.fileName || task.fileName || 'batch-invoice',
        currentPhase: 'Extracting fields, checking database ledger & evaluating active rules...',
      });

      try {
        // Compare against ledger (posted) and lightweight earlier items
        const result = runRules(inv, {
          masters,
          posted,
          batch: chunkInvoices,
          earlier: lightweightEarlier,
          irpPublicKeyPem: process.env.IRP_PUBLIC_KEY_PEM || undefined,
        });

        const enriched = enrichRuleResult(result);
        const databaseMatch = findDatabaseMatch(inv, {
          posted,
          batch: chunkInvoices,
          earlier: lightweightEarlier,
        });
        const sapMatch = await checkSapMatchForInvoice(inv, {
          prefetchedSapRes,
          cache: sapCache,
          sapCircuitBroken,
          onUnavailable: () => { sapCircuitBroken = true; },
        });

        const checkId = crypto.randomUUID();
        const tsNow = new Date().toISOString();

        if (enriched.status === 'PASS') {
          passCount++;
          // Auto-insert PASS invoices into ledger so subsequent chunks/uploads detect them
          try {
            await insertInvoiceIntoLedger(inv, { blocked: false, user, masters, source: 'Batch' });
          } catch (ledgerErr) {
            console.error(`[LEDGER_INSERT_WARN] Invoice ${inv.invoiceNo}:`, ledgerErr.message);
          }
          posted.push(inv);
        } else if (enriched.status === 'HOLD') {
          holdCount++;
        } else if (enriched.status === 'REJECT') {
          rejectCount++;
        }

        liveJobProgress.set(jobId, {
          status: 'RUNNING',
          processed: currentIdx,
          currentIndex: currentIdx,
          total,
          passCount,
          holdCount,
          rejectCount,
          currentInvoiceNo: inv.invoiceNo || inv.SupplierInvoice || `Row ${currentIdx}`,
          currentSupplier: inv.supplierName || inv.InvoicingParty || 'Supplier',
          currentFileName: inv.fileName || task.fileName || 'batch-invoice',
          currentStatus: enriched.status,
          currentPhase: `Checked ${inv.invoiceNo || `Row ${currentIdx}`} in database ledger (${enriched.status})`,
        });

        // Add lightweight representation for cross-chunk duplicate detection
        lightweightEarlier.push({
          id: inv.id,
          invoiceNo: inv.invoiceNo,
          supplierGstin: inv.supplierGstin,
          supplierName: inv.supplierName,
          invoiceDate: inv.invoiceDate,
          total: inv.total,
          description: inv.description,
          irn: inv.irn,
        });

        const storedPayload = {
          ...enriched,
          fields: publicView(inv),
          databaseMatch,
          sapMatch,
        };

        checksToInsert.push({
          ID: checkId,
          createdAt: tsNow,
          createdBy: String(user || 'User').slice(0, 100),
          source: String(source || 'S4').slice(0, 10),
          jobId: jobId,
          fileName: inv.fileName ? String(inv.fileName).slice(0, 255) : null,
          supplierName: inv.supplierName ? String(inv.supplierName).slice(0, 120) : null,
          supplierGstin: inv.supplierGstin ? String(inv.supplierGstin).slice(0, 15) : null,
          invoiceNo: inv.invoiceNo ? String(inv.invoiceNo).slice(0, 60) : null,
          invoiceDate: inv.invoiceDate || null,
          total: inv.total ?? null,
          status: String(enriched.status || 'PASS').slice(0, 10),
          resultJson: JSON.stringify(storedPayload),
        });

        for (const r of enriched.results) {
          resultsToInsert.push({
            ID: crypto.randomUUID(),
            check_ID: checkId,
            ruleId: String(r.id || '').slice(0, 20),
            title: String(r.title || '').slice(0, 120),
            tier: String(r.tier || 'PASS').slice(0, 10),
            text: String(r.text || '').slice(0, 1000),
          });

          if (['REJECT', 'HOLD', 'FLAG'].includes(r.tier)) {
            alertsToInsert.push({
              ID: crypto.randomUUID(),
              createdAt: tsNow,
              createdBy: String(user || 'User').slice(0, 100),
              check_ID: checkId,
              ruleId: String(r.id || '').slice(0, 20),
              title: String(r.title || '').slice(0, 120),
              tier: String(r.tier || 'REJECT').slice(0, 10),
              text: String(r.text || '').slice(0, 1000),
              decision: 'OPEN',
              invoiceNo: inv.invoiceNo ? String(inv.invoiceNo).slice(0, 60) : null,
              supplierName: inv.supplierName ? String(inv.supplierName).slice(0, 120) : null,
            });
          }
        }

        allPublicResults.push({
          id: inv.id,
          checkId,
          ...enriched,
          databaseMatch,
          sapMatch,
          invoice: publicView(inv),
        });

        // Short yield so HTTP polling sees live 1 of N, 2 of N progress smoothly
        if (total <= 250) {
          await new Promise(r => setTimeout(r, 12));
        }
      } catch (invErr) {
        // One bad invoice must not stop the chunk
        console.error(`[BAD_INVOICE_ERROR] Invoice ${inv.invoiceNo || 'unknown'}:`, invErr);
        jobErrors.push({
          invoiceNo: inv.invoiceNo || `Index ${cStart + i + 1}`,
          reason: invErr.message || String(invErr),
        });
      }
    }

    // Write chunk results to database in bulk per chunk
    if (checksToInsert.length > 0) {
      await cds.run(INSERT.into('ap.Checks').entries(checksToInsert));
    }
    if (resultsToInsert.length > 0) {
      await cds.run(INSERT.into('ap.CheckResults').entries(resultsToInsert));
    }
    if (alertsToInsert.length > 0) {
      await cds.run(INSERT.into('ap.Alerts').entries(alertsToInsert));
    }

    totalProcessed += chunkInvoices.length;

    // Save job progress after EVERY chunk (processed count, lastIndex, partial results & errors)
    await cds.run(
      UPDATE('ap.Jobs').set({
        processed: totalProcessed,
        lastIndex: totalProcessed,
        passCount,
        holdCount,
        rejectCount,
        resultJson: JSON.stringify(allPublicResults),
        errorsJson: JSON.stringify(jobErrors),
      }).where({ ID: jobId })
    );

    // Free memory for completed chunk records
    checksToInsert.length = 0;
    resultsToInsert.length = 0;
    alertsToInsert.length = 0;

    // Check if job was cancelled during or after processing chunk
    if (cancelledJobIds.has(jobId) || cancelledJobIds.has(task.jobId)) {
      cancelledJobIds.delete(jobId);
      cancelledJobIds.delete(task.jobId);
      liveJobProgress.delete(jobId);
      const cancelTime = new Date().toISOString();
      await cds.run(
        UPDATE('ap.Jobs').set({
          status: 'CANCELLED',
          finishedAt: cancelTime,
        }).where({ ID: jobId })
      );
      if (typeof audit === 'function') {
        await audit(
          'BATCH_JOB',
          null,
          `Batch job ${jobId} cancelled. ${totalProcessed} invoices were processed.`,
          { user, fileName: 'batch-job', result: 'CANCELLED' }
        );
      }
      return;
    }

    // Yield to the event loop between chunks so I/O, cancel requests, and polling proceed smoothly
    await new Promise(resolve => setTimeout(resolve, 60));
  }

  const finishedAt = new Date().toISOString();
  const durationMs = Date.now() - startTime;
  liveJobProgress.delete(jobId);

  // Mark job as DONE and store final results
  await cds.run(
    UPDATE('ap.Jobs').set({
      status: 'DONE',
      processed: totalProcessed,
      lastIndex: totalProcessed,
      passCount,
      holdCount,
      rejectCount,
      finishedAt,
      resultJson: JSON.stringify(allPublicResults),
      errorsJson: JSON.stringify(jobErrors),
    }).where({ ID: jobId })
  );

  if (typeof audit === 'function') {
    const fileOrSource = task.fileName || task.sourceFileName || (task.source === 'S4' ? 's4-extract.csv' : 'batch-job');
    await audit(
      'BATCH_JOB',
      null,
      `Batch job completed: ${total} total (${passCount} passed, ${holdCount} held, ${rejectCount} blocked) in ${durationMs}ms`,
      { user: 'User', fileName: fileOrSource, result: `DONE: ${passCount} passed, ${holdCount} held, ${rejectCount} blocked in ${durationMs}ms` }
    );
  }
}

async function createBatchJob({ invoices, user = 'User', source = 'S4', fileName = 'batch-job', masters, audit, initialErrors = [] }) {
  const list = Array.isArray(invoices) ? invoices : [];
  const total = list.length;
  if (total > 2000) {
    throw new Error(`This batch has ${total} invoices. The maximum per job is 2000. Please split the file.`);
  }

  const jobId = crypto.randomUUID();
  const ts = new Date().toISOString();
  const sourceBatch = JSON.stringify(list);

  // Create initial job record in database, persisting sourceBatch for resume capability
  await cds.run(
    INSERT.into('ap.Jobs').entries({
      ID: jobId,
      jobId,
      status: 'QUEUED',
      total,
      processed: 0,
      lastIndex: 0,
      passCount: 0,
      holdCount: 0,
      rejectCount: 0,
      sourceBatch,
      errorsJson: JSON.stringify(initialErrors || []),
      resultJson: JSON.stringify([]),
      createdAt: ts,
      createdBy: 'User',
    })
  );

  // Push to serialized in-process queue
  jobQueue.push({
    jobId,
    invoices: list,
    user: 'User',
    source,
    fileName,
    masters,
    audit,
    startingIndex: 0,
  });

  setImmediate(() => triggerWorker());

  return {
    jobId,
    id: jobId,
    status: 'QUEUED',
    total,
    processed: 0,
    lastIndex: 0,
    message: 'Processing started',
  };
}

async function cancelJob(jobId, audit = null, user = 'user') {
  cancelledJobIds.add(jobId);

  // If waiting in in-memory queue, remove it immediately
  const queueIdx = jobQueue.findIndex(j => j.jobId === jobId);
  if (queueIdx !== -1) {
    jobQueue.splice(queueIdx, 1);
  }

  const job = await cds.run(
    SELECT.one.from('ap.Jobs').where({ ID: jobId }).or({ jobId })
  );
  if (!job) {
    throw new Error(`Job ${jobId} not found`);
  }

  const now = new Date().toISOString();
  await cds.run(
    UPDATE('ap.Jobs').set({
      status: 'CANCELLED',
      finishedAt: now,
    }).where({ ID: job.ID })
  );

  const processed = job.processed || 0;

  if (typeof audit === 'function') {
    await audit(
      'BATCH_JOB',
      null,
      `Batch job ${jobId} cancelled. ${processed} invoices were processed.`,
      { user: user || job.createdBy || 'user', fileName: 'batch-job', result: 'CANCELLED' }
    );
  }

  return {
    jobId: job.jobId || job.ID,
    id: job.jobId || job.ID,
    status: 'CANCELLED',
    processed,
    total: job.total || 0,
    message: `Job cancelled. ${processed} invoices were processed.`,
  };
}

async function resumeJob(jobId, { masters, audit, user = 'user' } = {}) {
  const job = await cds.run(
    SELECT.one.from('ap.Jobs').where({ ID: jobId }).or({ jobId })
  );
  if (!job) {
    throw new Error(`Job ${jobId} not found`);
  }

  if (job.status !== 'FAILED' && job.status !== 'CANCELLED') {
    throw new Error(`Only FAILED or CANCELLED jobs can be resumed (current status: ${job.status})`);
  }

  if (!job.sourceBatch) {
    throw new Error(`Cannot resume job ${jobId}: source batch data is missing`);
  }

  cancelledJobIds.delete(jobId);
  cancelledJobIds.delete(job.ID);

  let invoices = [];
  try {
    invoices = JSON.parse(job.sourceBatch);
  } catch (e) {
    throw new Error('Failed to parse stored source batch: ' + e.message);
  }

  const startingIndex = job.lastIndex || job.processed || 0;
  if (startingIndex >= job.total && job.total > 0) {
    await cds.run(
      UPDATE('ap.Jobs').set({
        status: 'DONE',
        finishedAt: new Date().toISOString(),
      }).where({ ID: job.ID })
    );
    return {
      jobId: job.jobId || job.ID,
      id: job.jobId || job.ID,
      status: 'DONE',
      processed: job.total,
      total: job.total,
      message: 'Job was already completed',
    };
  }

  let existingResults = [];
  if (job.resultJson) {
    try { existingResults = JSON.parse(job.resultJson); } catch {}
  }

  let existingErrors = [];
  if (job.errorsJson) {
    try { existingErrors = JSON.parse(job.errorsJson); } catch {}
  }

  // Update status in database to QUEUED
  await cds.run(
    UPDATE('ap.Jobs').set({
      status: 'QUEUED',
      error: null,
    }).where({ ID: job.ID })
  );

  if (typeof audit === 'function') {
    await audit(
      'BATCH_JOB',
      null,
      `Batch job ${job.jobId || job.ID} resumed from invoice ${startingIndex + 1} of ${job.total}`,
      { user: user || job.createdBy || 'user', fileName: 'batch-job', result: 'RESUMED' }
    );
  }

  // Push resume task into the queue
  jobQueue.push({
    jobId: job.jobId || job.ID,
    invoices,
    user: user || job.createdBy || 'user',
    source: 'S4',
    masters,
    audit,
    isResume: true,
    startingIndex,
    initialResults: existingResults,
    initialErrors: existingErrors,
    initialPassCount: job.passCount || 0,
    initialHoldCount: job.holdCount || 0,
    initialRejectCount: job.rejectCount || 0,
  });

  setImmediate(() => triggerWorker());

  return {
    jobId: job.jobId || job.ID,
    id: job.jobId || job.ID,
    status: 'QUEUED',
    total: job.total,
    processed: startingIndex,
    message: `Job resumed from invoice ${startingIndex + 1}`,
  };
}

async function getJob(jobId) {
  const rawJob = await cds.run(
    SELECT.one.from('ap.Jobs').where({ ID: jobId }).or({ jobId })
  );
  if (!rawJob) return null;
  const job = normalizeRow(rawJob, 'ap.Jobs');

  let results = null;
  if (job.resultJson) {
    try { results = JSON.parse(job.resultJson); } catch {}
  }

  let errors = [];
  if (job.errorsJson) {
    try { errors = JSON.parse(job.errorsJson); } catch {}
  }

  const live = liveJobProgress.get(job.jobId || job.ID) || liveJobProgress.get(jobId) || null;

  let passCount = Number(job.passCount || 0);
  let holdCount = Number(job.holdCount || 0);
  let rejectCount = Number(job.rejectCount || 0);
  let processed = Number(job.processed || 0);
  const total = Number(job.total || (live && live.total) || 0);

  if (live && (job.status === 'QUEUED' || job.status === 'RUNNING')) {
    processed = Math.max(processed, Number(live.processed || 0));
    passCount = Math.max(passCount, Number(live.passCount || 0));
    holdCount = Math.max(holdCount, Number(live.holdCount || 0));
    rejectCount = Math.max(rejectCount, Number(live.rejectCount || 0));
  }

  if (passCount === 0 && holdCount === 0 && rejectCount === 0 && Array.isArray(results) && results.length > 0) {
    for (const r of results) {
      const st = String(r.status || '').toUpperCase();
      if (st === 'PASS') passCount++;
      else if (st === 'HOLD' || st === 'FLAG') holdCount++;
      else if (st === 'REJECT') rejectCount++;
    }
  }

  return {
    jobId: job.jobId || job.ID,
    id: job.jobId || job.ID,
    status: (live && job.status === 'QUEUED' && live.status === 'RUNNING') ? 'RUNNING' : job.status,
    total,
    processed,
    lastIndex: Number(job.lastIndex || processed || 0),
    passCount,
    holdCount,
    rejectCount,
    currentIndex: live ? live.currentIndex : processed,
    currentInvoiceNo: live ? live.currentInvoiceNo : null,
    currentSupplier: live ? live.currentSupplier : null,
    currentFileName: live ? live.currentFileName : null,
    currentPhase: live ? live.currentPhase : null,
    startedAt: job.startedAt || null,
    finishedAt: job.finishedAt || null,
    createdAt: job.createdAt || null,
    error: job.error || null,
    errors,
    results,
  };
}

module.exports = {
  createBatchJob,
  cancelJob,
  resumeJob,
  getJob,
  markInterruptedJobsAsFailed,
  CHUNK_SIZE,
};
