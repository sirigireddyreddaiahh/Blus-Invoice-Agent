'use strict';
const ExcelJS = require('exceljs');

const HISTORY_EXPORT_HEADERS = [
  'Time',
  'Source',
  'File',
  'Invoice Number',
  'Supplier',
  'Supplier GSTIN',
  'Total (INR)',
  'Status',
  'Reviewer',
  'Duplicate invoice',
  'GSTIN multi-vendor reuse',
  'Repeat service bill',
  'Split invoice pattern',
];

const S4_EXPORT_HEADERS = [
  'ID',
  'Supplier',
  'Supplier GSTIN',
  'Invoice Number',
  'Date',
  'Total (INR)',
  'Database match',
  'Status',
  'Reason',
  'Duplicate invoice',
  'GSTIN multi-vendor reuse',
  'Repeat service bill',
  'Split invoice pattern',
];

const LEDGER_EXPORT_HEADERS = [
  'Invoice No',
  'Supplier',
  'GSTIN',
  'Invoice Date',
  'Posting Date',
  'Amount (INR)',
  'Fiscal Year',
  'Source',
];

function cleanRuleText(text) {
  return String(text || '').replace(/^AP-\d+\s*·?\s*/i, '').trim();
}

/**
 * Normalizes raw database check rows into uniform export row arrays
 * for Check History without any rule codes.
 */
function extractHistoryRowCells(r) {
  let parsed = {};
  try {
    parsed = typeof r.resultJson === 'string' ? JSON.parse(r.resultJson || '{}') : (r.resultJson || {});
  } catch {
    parsed = {};
  }
  const results = Array.isArray(parsed.results) ? parsed.results : [];
  const getRuleTier = (id) => {
    const hit = results.find(x => x.id === id);
    if (!hit) return 'PASS';
    const cleaned = cleanRuleText(hit.text);
    return cleaned ? `${hit.tier}: ${cleaned}` : hit.tier;
  };

  return [
    r.createdAt || '',
    r.source || 'CHAT',
    r.fileName || r.source || '',
    r.invoiceNo || '',
    r.supplierName || '',
    r.supplierGstin || '',
    r.total !== undefined && r.total !== null ? Number(r.total) : '',
    r.status || 'PASS',
    r.createdBy || 'reviewer',
    getRuleTier('AP-02'),
    getRuleTier('AP-03'),
    getRuleTier('AP-09'),
    getRuleTier('AP-11'),
  ];
}

/**
 * Normalizes raw database check rows into uniform export row arrays
 * for S/4HANA Extract results without any rule codes.
 */
function extractS4RowCells(r) {
  let parsed = {};
  try {
    parsed = typeof r.resultJson === 'string' ? JSON.parse(r.resultJson || '{}') : (r.resultJson || {});
  } catch {
    parsed = {};
  }
  const results = Array.isArray(parsed.results) ? parsed.results : [];
  const getRuleTier = (id) => {
    const hit = results.find(x => x.id === id);
    if (!hit) return 'PASS';
    const cleaned = cleanRuleText(hit.text);
    return cleaned ? `${hit.tier}: ${cleaned}` : hit.tier;
  };

  const dbMatch = parsed.databaseMatch || {};
  let dbMatchStr = 'Not found in database';
  if (dbMatch.matched) {
    dbMatchStr = `Found in database (${cleanRuleText(dbMatch.reason) || 'Matched'})`;
  }

  const activeResults = results.filter(x => ['AP-02', 'AP-03', 'AP-09', 'AP-11'].includes(x.id));
  const activeNonPass = activeResults
    .filter(x => x.tier !== 'PASS' && x.tier !== 'SKIPPED')
    .map(x => cleanRuleText(x.text))
    .join(' | ');
  const gstinMissing = !r.supplierGstin || activeResults.some(x => x.id === 'AP-03' && (x.tier === 'SKIPPED' || /GSTIN not provided/i.test(x.text)));
  let reason = activeNonPass || 'All active rules passed';
  if (gstinMissing && !/GSTIN not provided/i.test(reason)) {
    reason = `${reason} · GSTIN not provided`;
  }

  return [
    r.invoiceNo || r.ID || '',
    r.supplierName || '',
    r.supplierGstin || '',
    r.invoiceNo || '',
    r.invoiceDate || '',
    r.total !== undefined && r.total !== null ? Number(r.total) : '',
    dbMatchStr,
    r.status || 'PASS',
    reason,
    getRuleTier('AP-02'),
    getRuleTier('AP-03'),
    getRuleTier('AP-09'),
    getRuleTier('AP-11'),
  ];
}

function filterCheckRows(rows, filters = {}) {
  const statusFilter = filters.status ? String(filters.status).trim() : 'ALL';
  const fromDate = filters.fromDate ? String(filters.fromDate).trim() : '';
  const toDate = filters.toDate ? String(filters.toDate).trim() : '';
  const supplierQuery = filters.supplier ? String(filters.supplier).trim().toLowerCase() : '';

  return (rows || []).filter(row => {
    if (statusFilter && statusFilter !== 'ALL' && row.status !== statusFilter) return false;
    const rowDate = row.invoiceDate || (row.createdAt ? String(row.createdAt).slice(0, 10) : '');
    if (fromDate && rowDate && rowDate < fromDate) return false;
    if (toDate && rowDate && rowDate > toDate) return false;
    if (supplierQuery) {
      const hay = `${row.supplierName || ''} ${row.supplierGstin || ''} ${row.invoiceNo || ''}`.toLowerCase();
      if (!hay.includes(supplierQuery)) return false;
    }
    return true;
  });
}

function escapeCsvCell(val) {
  const s = String(val === undefined || val === null ? '' : val);
  if (s.includes(',') || s.includes('"') || s.includes('\n') || s.includes('\r')) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

/**
 * Returns ExcelJS fill and font styling for PASS / HOLD / REJECT cells (green / amber / red).
 */
function getStatusCellStyle(cellValue) {
  const text = String(cellValue === undefined || cellValue === null ? '' : cellValue).trim().toUpperCase();
  if (text === 'PASS' || text.startsWith('PASS:') || text.startsWith('PASS ')) {
    return {
      fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFDCFCE7' } },
      font: { bold: true, color: { argb: 'FF15803D' }, name: 'Calibri', size: 11 },
    };
  }
  if (text === 'HOLD' || text.startsWith('HOLD:') || text.startsWith('HOLD ')) {
    return {
      fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFEF3C7' } },
      font: { bold: true, color: { argb: 'FFB45309' }, name: 'Calibri', size: 11 },
    };
  }
  if (text === 'REJECT' || text.startsWith('REJECT:') || text.startsWith('REJECT ')) {
    return {
      fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFEE2E2' } },
      font: { bold: true, color: { argb: 'FFB91C1C' }, name: 'Calibri', size: 11 },
    };
  }
  return null;
}

/**
 * Streams CSV export in chunks of 500 rows directly to the HTTP response.
 */
async function streamCsv({ res, filename, headers, fetchChunk, extractCells }) {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.write('\uFEFF' + headers.map(escapeCsvCell).join(',') + '\r\n');

  let offset = 0;
  const CHUNK_SIZE = 500;
  while (true) {
    const chunk = await fetchChunk(offset, CHUNK_SIZE);
    if (!chunk || chunk.length === 0) break;
    let text = '';
    for (const r of chunk) {
      const cells = extractCells(r);
      text += cells.map(escapeCsvCell).join(',') + '\r\n';
    }
    res.write(text);
    offset += chunk.length;
    if (chunk.length < CHUNK_SIZE) break;
  }
  res.end();
}

/**
 * Streams Excel (.xlsx) export in chunks of 500 rows directly to the HTTP response
 * using ExcelJS streaming WorkbookWriter so memory stays low.
 */
async function streamExcel({ res, filename, sheetName, headers, totalColIndex, fetchChunk, extractCells }) {
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

  const workbook = new ExcelJS.stream.xlsx.WorkbookWriter({ stream: res, useStyles: true });
  const sheet = workbook.addWorksheet(sheetName);

  sheet.columns = headers.map(h => ({
    header: h,
    width: Math.max(16, h.length + 4),
  }));

  const colWidths = headers.map(h => Math.max(16, h.length + 4));

  const headerRow = sheet.getRow(1);
  headerRow.height = 24;
  headerRow.eachCell((cell) => {
    cell.font = { bold: true, color: { argb: 'FF0F172A' }, name: 'Calibri', size: 11 };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF1F5F9' } };
    cell.alignment = { vertical: 'middle', horizontal: 'left' };
    cell.border = {
      bottom: { style: 'thin', color: { argb: 'FFCBD5E1' } },
    };
  });
  headerRow.commit();

  let offset = 0;
  const CHUNK_SIZE = 500;
  while (true) {
    const chunk = await fetchChunk(offset, CHUNK_SIZE);
    if (!chunk || chunk.length === 0) break;

    for (const r of chunk) {
      const cells = extractCells(r);
      cells.forEach((val, idx) => {
        const len = String(val ?? '').length;
        if (len + 3 > colWidths[idx]) {
          colWidths[idx] = Math.min(len + 3, 50);
        }
      });
      const dataRow = sheet.addRow(cells);
      dataRow.eachCell({ includeEmpty: true }, (cell, colNumber) => {
        cell.font = { name: 'Calibri', size: 11, color: { argb: 'FF1E293B' } };
        cell.alignment = {
          vertical: 'middle',
          horizontal: colNumber === totalColIndex ? 'right' : 'left',
        };
        if (colNumber === totalColIndex && typeof cell.value === 'number') {
          cell.numFmt = '#,##0.00';
        }
        const statusStyle = getStatusCellStyle(cell.value);
        if (statusStyle) {
          cell.fill = statusStyle.fill;
          cell.font = statusStyle.font;
        }
      });
      dataRow.commit();
    }

    offset += chunk.length;
    if (chunk.length < CHUNK_SIZE) break;
  }

  sheet.columns = colWidths.map(w => ({ width: w }));
  await sheet.commit();
  await workbook.commit();
}

/**
 * In-memory fallback generators for backward compatibility in acceptance tests
 */
function generateHistoryCsv(rows) {
  const lines = [HISTORY_EXPORT_HEADERS.map(escapeCsvCell).join(',')];
  for (const r of rows || []) {
    const cells = extractHistoryRowCells(r);
    lines.push(cells.map(escapeCsvCell).join(','));
  }
  return '\uFEFF' + lines.join('\r\n');
}

async function generateHistoryExcelBuffer(rows) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Blus Invoice Agent';
  workbook.created = new Date();
  const sheet = workbook.addWorksheet('Check History');

  const headerRow = sheet.addRow(HISTORY_EXPORT_HEADERS);
  headerRow.height = 24;
  headerRow.eachCell((cell) => {
    cell.font = { bold: true, color: { argb: 'FF0F172A' }, name: 'Calibri', size: 11 };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF1F5F9' } };
    cell.alignment = { vertical: 'middle', horizontal: 'left' };
    cell.border = { bottom: { style: 'thin', color: { argb: 'FFCBD5E1' } } };
  });

  for (const r of rows || []) {
    const cells = extractHistoryRowCells(r);
    const dataRow = sheet.addRow(cells);
    dataRow.eachCell({ includeEmpty: true }, (cell, colNumber) => {
      cell.font = { name: 'Calibri', size: 11, color: { argb: 'FF1E293B' } };
      cell.alignment = {
        vertical: 'middle',
        horizontal: colNumber === 7 ? 'right' : 'left',
      };
      if (colNumber === 7 && typeof cell.value === 'number') {
        cell.numFmt = '#,##0.00';
      }
      if (colNumber === 8 || (colNumber >= 10 && colNumber <= 13)) {
        const statusStyle = getStatusCellStyle(cell.value);
        if (statusStyle) {
          cell.fill = statusStyle.fill;
          cell.font = statusStyle.font;
        }
      }
    });
  }

  sheet.columns.forEach((column, colIdx) => {
    const headerText = HISTORY_EXPORT_HEADERS[colIdx] || '';
    let maxLen = headerText.length;
    column.eachCell({ includeEmpty: true }, (cell) => {
      const val = cell.value === undefined || cell.value === null ? '' : String(cell.value);
      if (val.length > maxLen) {
        maxLen = val.length;
      }
    });
    column.width = Math.min(Math.max(maxLen + 3, 12), 55);
  });

  const arrayBuffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(arrayBuffer);
}

function extractLedgerRowCells(r) {
  const s = String(r.source || '').trim().toUpperCase();
  let sourceLabel = 'Import';
  if (s === 'BATCH' || s === 'S4') sourceLabel = 'Batch';
  else if (s === 'CHAT' || s === 'UPLOAD') sourceLabel = 'Chat';

  const postingDate = r.postingDate || (r.postedAt ? String(r.postedAt).slice(0, 10) : (r.invoiceDate || ''));
  return [
    r.invoiceNo || '',
    r.supplierName || '',
    r.supplierGstin || '',
    r.invoiceDate || '',
    postingDate,
    r.total !== undefined && r.total !== null ? Number(r.total) : '',
    r.fiscalYear || '',
    sourceLabel,
  ];
}

module.exports = {
  HISTORY_EXPORT_HEADERS,
  S4_EXPORT_HEADERS,
  LEDGER_EXPORT_HEADERS,
  cleanRuleText,
  extractHistoryRowCells,
  extractS4RowCells,
  extractLedgerRowCells,
  filterCheckRows,
  escapeCsvCell,
  getStatusCellStyle,
  streamCsv,
  streamExcel,
  generateHistoryCsv,
  generateHistoryExcelBuffer,
};

