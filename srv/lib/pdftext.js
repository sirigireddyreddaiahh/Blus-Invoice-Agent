'use strict';
// Extracts text from the text layer of a PDF document (supports pdfjs-dist, FlateDecode streams, and literal strings).
const zlib = require('zlib');

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
      pdfjsLib = await import('pdfjs-dist/build/pdf.mjs');
    } catch {
      pdfjsLib = await import('pdfjs-dist/legacy/build/pdf.mjs');
    }
    const loadingTask = pdfjsLib.getDocument({ data: new Uint8Array(pdfBuffer) });
    const doc = await loadingTask.promise;
    pageCount = doc.numPages || 1;
    const pageTexts = [];
    for (let i = 1; i <= pageCount; i++) {
      const page = await doc.getPage(i);
      const content = await page.getTextContent();
      const lines = [];
      let lastY = null;
      for (const item of content.items || []) {
        const y = item.transform ? Math.round(item.transform[5]) : null;
        if (lastY !== null && y !== null && Math.abs(y - lastY) > 4) {
          lines.push('\n');
        }
        lines.push(item.str || '');
        if (y !== null) lastY = y;
      }
      const joined = lines.join(' ').replace(/\s*\n\s*/g, '\n').trim();
      if (joined) pageTexts.push(joined);
    }
    text = pageTexts.join('\n').trim();
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
