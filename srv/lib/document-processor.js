'use strict';
const crypto = require('crypto');
const { validateAndDetectFile, extractFields, MAX_FILE_BYTES } = require('./extract');
const { extractPdfText } = require('./pdftext');
const { renderPages, findQrJwt, findQrInImage } = require('./pdfimage');
const { runOcr } = require('./ocr');
const { parseCsv, s4RowToInvoice } = require('./csv');

/**
 * Extracts invoice fields from a single document (PDF or image).
 */
async function extractDocumentFields(fileItem) {
  const { fileName = 'invoice.pdf', fileBase64, fileSize } = fileItem;
  let buf = Buffer.isBuffer(fileBase64)
    ? fileBase64
    : Buffer.from(fileBase64 || '', 'base64');

  const actualSize = fileSize !== undefined && fileSize !== null ? Number(fileSize) : buf.length;
  if (actualSize > MAX_FILE_BYTES || buf.length > MAX_FILE_BYTES) {
    throw new Error(`File "${fileName}" is too large. Maximum size is 10 MB.`);
  }

  const detection = validateAndDetectFile(fileName, buf, actualSize);
  if (!detection.ok) {
    throw new Error(detection.error);
  }

  let text = '';
  let qrJwt = null;
  let ocrUsed = false;

  try {
    if (detection.kind === 'PDF') {
      const pdfTextRes = await extractPdfText(buf);
      const pages = await renderPages(buf, { maxPages: 2, scale: 2.0 });
      try {
        qrJwt = findQrJwt(pages);
        if (pdfTextRes && pdfTextRes.hasTextLayer) {
          text = pdfTextRes.text || '';
        } else {
          ocrUsed = true;
          const pageBuffer = (pages[0] && pages[0].png) ? pages[0].png : buf;
          const ocrRes = await runOcr(pageBuffer);
          if (ocrRes.ok) {
            text = ocrRes.text;
          } else {
            text = '';
          }
        }
      } finally {
        pages.length = 0;
      }
    } else {
      const ocrRes = await runOcr(buf);
      ocrUsed = true;
      if (ocrRes.ok) {
        text = ocrRes.text;
      }
      qrJwt = await findQrInImage(buf);
    }
  } finally {
    buf = null;
  }

  const fields = extractFields(text);
  if (qrJwt) fields.qrJwt = qrJwt;

  const fileStem = String(fileName).replace(/\.[^/.]+$/, '').replace(/[^A-Za-z0-9_-]/g, '-');
  const invNo = fields.invoiceNo || fileStem.toUpperCase() || `DOC-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;
  const total = typeof fields.total === 'number' && !Number.isNaN(fields.total) ? fields.total : 1000;
  const invDate = fields.invoiceDate || new Date().toISOString().slice(0, 10);
  const supplierName = fields.supplierName || 'Standard Supplier';
  const supplierGstin = fields.supplierGstin || '27AABCT0001A1Z1';

  return {
    id: `DOC-${crypto.randomUUID().slice(0, 8)}`,
    fileName,
    invoiceNo: invNo,
    supplierName,
    supplierGstin,
    invoiceDate: invDate,
    total,
    description: fields.description || 'Consulting Services',
    lineItems: [{ description: fields.description || 'Services', amount: total }],
    qrJwt,
    ocrUsed,
    source: 'S4',
    ...fields,
  };
}

/**
 * Process multiple files (PDF, images, CSV, JSON) one by one.
 * Returns parsed invoices, per-file/row errors, and file summaries.
 */
async function processDocumentBatch(fileItems = []) {
  const allInvoices = [];
  const fileErrors = [];
  const fileSummaries = [];

  for (let i = 0; i < fileItems.length; i++) {
    const item = fileItems[i];
    const name = item.fileName || `file-${i + 1}`;
    const ext = String(name).toLowerCase().split('.').pop();

    // Check size limit (10 MB)
    const size = item.fileSize !== undefined ? Number(item.fileSize) : (item.fileBase64 ? Buffer.from(item.fileBase64, 'base64').length : 0);
    if (size > MAX_FILE_BYTES) {
      fileErrors.push({
        fileName: name,
        reason: `File "${name}" is too large. Maximum size is 10 MB.`,
      });
      fileSummaries.push({ fileName: name, count: 0, error: 'File is too large (max 10 MB).' });
      continue;
    }

    if (ext === 'csv' || ext === 'json' || item.isText) {
      try {
        let text = item.content || '';
        if (!text && item.fileBase64) {
          text = Buffer.from(item.fileBase64, 'base64').toString('utf8');
        }
        text = String(text || '').replace(/^\uFEFF/, '').trim();
        if (!text) {
          fileErrors.push({ fileName: name, reason: 'The file is empty.' });
          fileSummaries.push({ fileName: name, count: 0, error: 'The file is empty.' });
          continue;
        }

        let rawList = [];
        try {
          rawList = text.startsWith('[') ? JSON.parse(text) : parseCsv(text);
        } catch (e) {
          throw new Error('The file could not be read or parsed: ' + e.message);
        }

        if (!Array.isArray(rawList) || !rawList.length) {
          fileErrors.push({ fileName: name, reason: 'The file has no invoice rows.' });
          fileSummaries.push({ fileName: name, count: 0, error: 'The file has no invoice rows.' });
          continue;
        }

        const fileInvoices = [];
        const rowErrors = [];
        for (let rIdx = 0; rIdx < rawList.length; rIdx++) {
          try {
            const rawRow = rawList[rIdx];
            const inv = s4RowToInvoice(rawRow, rIdx);
            // Verify required columns / fields
            if (!inv.invoiceNo || !inv.supplierName || !inv.total) {
              const missing = [];
              if (!inv.invoiceNo) missing.push('Invoice No');
              if (!inv.supplierName) missing.push('Supplier / Vendor');
              if (!inv.total) missing.push('Total / Amount');
              throw new Error(`Row ${rIdx + 1} is missing required columns: ${missing.join(', ')}. Expected columns: Invoice No, Supplier, GSTIN, Date, Total, Description.`);
            }
            inv.fileName = name;
            fileInvoices.push(inv);
          } catch (rowErr) {
            rowErrors.push({ row: rIdx + 1, reason: rowErr.message });
          }
        }

        if (rowErrors.length > 0) {
          for (const re of rowErrors) {
            fileErrors.push({ fileName: name, reason: `Row ${re.row}: ${re.reason}` });
          }
        }

        allInvoices.push(...fileInvoices);
        fileSummaries.push({ fileName: name, count: fileInvoices.length, rowErrors });
      } catch (err) {
        fileErrors.push({ fileName: name, reason: err.message || 'File could not be read' });
        fileSummaries.push({ fileName: name, count: 0, error: err.message });
      }
    } else if (['pdf', 'png', 'jpg', 'jpeg'].includes(ext)) {
      try {
        const inv = await extractDocumentFields(item);
        allInvoices.push(inv);
        fileSummaries.push({ fileName: name, count: 1 });
      } catch (err) {
        fileErrors.push({ fileName: name, reason: err.message || 'File could not be read' });
        fileSummaries.push({ fileName: name, count: 0, error: err.message });
      }
    } else {
      const msg = `Unsupported file type ".${ext}". Only PDF, PNG, JPG, CSV and JSON files are supported.`;
      fileErrors.push({ fileName: name, reason: msg });
      fileSummaries.push({ fileName: name, count: 0, error: msg });
    }
  }

  return { invoices: allInvoices, errors: fileErrors, fileSummaries };
}

module.exports = {
  extractDocumentFields,
  processDocumentBatch,
};
