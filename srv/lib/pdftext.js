'use strict';
// Extracts text from the text layer of a PDF document (supports pdfjs-dist, FlateDecode streams, and literal strings).
const path = require('path');
const zlib = require('zlib');

let cachedPdfjsPaths = null;
function getPdfjsAssetPaths() {
  if (cachedPdfjsPaths) return cachedPdfjsPaths;
  try {
    const pdfjsDir = path.dirname(require.resolve('pdfjs-dist/package.json'));
    cachedPdfjsPaths = {
      standardFontDataUrl: path.join(pdfjsDir, 'standard_fonts') + path.sep,
      cMapUrl: path.join(pdfjsDir, 'cmaps') + path.sep,
      cMapPacked: true,
    };
  } catch {
    cachedPdfjsPaths = {};
  }
  return cachedPdfjsPaths;
}

function extractTextOperators(contentStr) {
  const parts = [];
  // Match literal strings (...) and TJ arrays [...]
  for (const m of contentStr.matchAll(/\(([^()\\]*(?:\\.[^()\\]*)*)\)\s*(?:Tj|'|")/g)) {
    parts.push(m[1].replace(/\\([()\\nrt])/g, (_, c) => (c === 'n' ? '\n' : c === 'r' ? '\r' : c === 't' ? '\t' : c)));
  }
  for (const arrMatch of contentStr.matchAll(/\[([^\]]+)\]\s*TJ/g)) {
    const sub = [...arrMatch[1].matchAll(/\(([^()\\]*(?:\\.[^()\\]*)*)\)/g)]
      .map(x => x[1].replace(/\\([()\\])/g, '$1'))
      .join('');
    if (sub) parts.push(sub);
  }
  if (parts.length === 0) {
    for (const m of contentStr.matchAll(/\(([^()]{2,200})\)/g)) {
      const s = m[1].replace(/\\([()\\])/g, '$1');
      if (/[A-Za-z0-9]/.test(s) && !/^PDF-|Identity-H|Adobe|Helvetica/i.test(s)) {
        parts.push(s);
      }
    }
  }
  return parts.join('\n').trim();
}

async function extractPdfText(pdfBuffer) {
  if (!Buffer.isBuffer(pdfBuffer) || pdfBuffer.length < 5) {
    return { text: '', pageCount: 0, hasTextLayer: false };
  }

  let text = '';
  let pageCount = 1;

  // Method 1: pdfjs-dist text layer extraction
  try {
    let pdfjsLib;
    try {
      pdfjsLib = await import('pdfjs-dist/legacy/build/pdf.mjs');
    } catch {
      pdfjsLib = await import('pdfjs-dist/build/pdf.mjs');
    }
    const assetPaths = getPdfjsAssetPaths();
    const loadingTask = pdfjsLib.getDocument({
      data: new Uint8Array(pdfBuffer),
      ...assetPaths,
      verbosity: 0,
    });
    const doc = await loadingTask.promise;
    try {
      pageCount = doc.numPages || 1;
      const pageTexts = [];
      for (let i = 1; i <= pageCount; i++) {
        const page = await doc.getPage(i);
        try {
          const content = await page.getTextContent();
          const rows = [];
          for (const item of content.items || []) {
            const str = String(item.str || '');
            if (!str.trim()) continue;
            const x = item.transform ? Number(item.transform[4] || 0) : 0;
            const y = item.transform ? Number(item.transform[5] || 0) : 0;
            let row = rows.find(r => Math.abs(r.y - y) <= 4);
            if (!row) {
              row = { y, items: [] };
              rows.push(row);
            }
            row.items.push({ x, str: str.trim() });
          }
          rows.sort((a, b) => b.y - a.y);
          const joined = rows
            .map(r => {
              r.items.sort((a, b) => a.x - b.x);
              return r.items.map(it => it.str).filter(Boolean).join(' ');
            })
            .filter(Boolean)
            .join('\n')
            .trim();
          if (joined) pageTexts.push(joined);
        } finally {
          try { if (page.cleanup) page.cleanup(); } catch {}
        }
      }
      text = pageTexts.join('\n').trim();
    } finally {
      try { if (doc.cleanup) doc.cleanup(); } catch {}
      try { if (doc.destroy) await doc.destroy(); } catch {}
    }
  } catch {
    // Fallback to raw stream / FlateDecode extraction
  }

  // Method 2: Decompress FlateDecode streams or parse raw PDF strings
  if (!text) {
    try {
      const raw = pdfBuffer.toString('latin1');
      const collected = [];
      let pos = 0;
      while (true) {
        const sIdx = raw.indexOf('stream', pos);
        if (sIdx === -1) break;
        let dataStart = sIdx + 6;
        if (raw[dataStart] === '\r' && raw[dataStart + 1] === '\n') dataStart += 2;
        else if (raw[dataStart] === '\n' || raw[dataStart] === '\r') dataStart += 1;
        const eIdx = raw.indexOf('endstream', dataStart);
        if (eIdx === -1) break;
        const streamBuf = pdfBuffer.subarray(dataStart, eIdx);
        try {
          const inflated = zlib.inflateSync(streamBuf).toString('latin1');
          const extracted = extractTextOperators(inflated);
          if (extracted) collected.push(extracted);
        } catch {
          const extracted = extractTextOperators(streamBuf.toString('latin1'));
          if (extracted) collected.push(extracted);
        }
        pos = eIdx + 9;
      }
      if (collected.length > 0) {
        text = collected.join('\n').trim();
      } else {
        text = extractTextOperators(raw);
      }
    } catch {
      text = '';
    }
  }

  const hasTextLayer = text.replace(/\s+/g, '').length >= 15;
  return { text, pageCount, hasTextLayer };
}

module.exports = { extractPdfText };
