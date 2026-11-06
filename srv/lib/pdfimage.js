'use strict';
// Uses jsqr to scan rendered PDF pages or uploaded PNG/JPG images for QR codes.
// Isolates pdfjs-dist + @napi-rs/canvas page rendering in a child process so native
// Skia SIGSEGV / SIGABRT on complex PDFs never crashes the main Node.js server (502).
const path = require('path');
const { spawn } = require('child_process');
const jsQR = require('jsqr');

const WORKER_SCRIPT = `
const path = require('path');
try {
  const { Path2D, ImageData } = require('@napi-rs/canvas');
  if (Path2D && !global.Path2D) global.Path2D = Path2D;
  if (ImageData && !global.ImageData) global.ImageData = ImageData;
} catch {}

function getPdfjsAssetPaths() {
  try {
    const pdfjsDir = path.dirname(require.resolve('pdfjs-dist/package.json'));
    return {
      standardFontDataUrl: path.join(pdfjsDir, 'standard_fonts') + path.sep,
      cMapUrl: path.join(pdfjsDir, 'cmaps') + path.sep,
      cMapPacked: true,
    };
  } catch {
    return {};
  }
}

const chunks = [];
process.stdin.on('data', c => chunks.push(c));
process.stdin.on('end', async () => {
  try {
    const pdfBuffer = Buffer.concat(chunks);
    const maxPagesOpt = Number(process.env.PDF_MAX_PAGES || 2);
    const scaleOpt = Number(process.env.PDF_SCALE || 2.0);
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
    const maxPages = Math.min(doc.numPages, maxPagesOpt);
    const out = [];
    const { createCanvas } = require('@napi-rs/canvas');
    for (let i = 1; i <= maxPages; i++) {
      const page = await doc.getPage(i);
      const viewport = page.getViewport({ scale: scaleOpt });
      const w = Math.max(1, Math.floor(viewport.width));
      const h = Math.max(1, Math.floor(viewport.height));
      const canvas = createCanvas(w, h);
      const ctx = canvas.getContext('2d');
      await page.render({ canvasContext: ctx, viewport }).promise;
      const png = canvas.toBuffer('image/png');
      out.push({ width: w, height: h, pngBase64: png.toString('base64') });
    }
    process.stdout.write(JSON.stringify({ ok: true, pages: out }), () => process.exit(0));
  } catch (err) {
    process.stdout.write(JSON.stringify({ ok: false, pages: [] }), () => process.exit(0));
  }
});
`;

function runRenderWorker(pdfBuffer, options = {}) {
  return new Promise((resolve) => {
    if (!Buffer.isBuffer(pdfBuffer) || pdfBuffer.length < 5) {
      return resolve([]);
    }
    let settled = false;
    const finish = (val) => {
      if (!settled) {
        settled = true;
        resolve(val);
      }
    };

    let child;
    try {
      child = spawn(process.execPath, ['-e', WORKER_SCRIPT], {
        cwd: path.resolve(__dirname, '../..'),
        env: {
          ...process.env,
          PDF_MAX_PAGES: String(options.maxPages || 2),
          PDF_SCALE: String(options.scale || 2.0),
        },
        stdio: ['pipe', 'pipe', 'ignore'],
      });
    } catch {
      return finish([]);
    }

    const outChunks = [];
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch {}
      finish([]);
    }, options.timeoutMs || 12000);

    child.stdout.on('data', (d) => outChunks.push(d));
    child.on('error', () => {
      clearTimeout(timer);
      finish([]);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0 || outChunks.length === 0) {
        return finish([]);
      }
      try {
        const raw = Buffer.concat(outChunks).toString('utf8').trim();
        const jsonStart = raw.indexOf('{"ok":');
        const parsed = JSON.parse(jsonStart >= 0 ? raw.slice(jsonStart) : raw);
        if (parsed && Array.isArray(parsed.pages)) {
          return finish(parsed.pages);
        }
      } catch {}
      finish([]);
    });

    try {
      child.stdin.on('error', () => {});
      child.stdin.end(pdfBuffer);
    } catch {
      clearTimeout(timer);
      finish([]);
    }
  });
}

async function decodePngBufferToPage(pngBuffer) {
  try {
    const { createCanvas, loadImage } = require('@napi-rs/canvas');
    const img = await loadImage(pngBuffer);
    const w = Math.max(1, Math.floor(img.width));
    const h = Math.max(1, Math.floor(img.height));
    const canvas = createCanvas(w, h);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0, w, h);
    const imgData = ctx.getImageData(0, 0, w, h);
    return {
      width: imgData.width || w,
      height: imgData.height || h,
      data: new Uint8ClampedArray(imgData.data),
      png: pngBuffer,
    };
  } catch {
    return null;
  }
}

async function renderPages(pdfBuffer, options = {}) {
  try {
    const rawPages = await runRenderWorker(pdfBuffer, options);
    const pages = [];
    for (const p of rawPages) {
      if (p && p.pngBase64) {
        const pngBuf = Buffer.from(p.pngBase64, 'base64');
        const decoded = await decodePngBufferToPage(pngBuf);
        if (decoded) {
          pages.push(decoded);
        }
      }
    }
    return pages;
  } catch {
    return [];
  }
}

function findQrJwt(pages) {
  if (!Array.isArray(pages)) return null;
  for (const page of pages) {
    if (page && page.data && page.width && page.height) {
      try {
        const w = Math.floor(page.width);
        const h = Math.floor(page.height);
        if (page.data.length === w * h * 4) {
          const code = jsQR(new Uint8ClampedArray(page.data), w, h);
          if (code && code.data && code.data.split('.').length === 3) {
            return code.data;
          }
        }
      } catch {
        // Ignore binarizer errors on non-QR pages
      }
    }
  }
  return null;
}

async function findQrInImage(imageBuffer) {
  if (!Buffer.isBuffer(imageBuffer) || imageBuffer.length < 8) return null;
  try {
    const { createCanvas, loadImage } = require('@napi-rs/canvas');
    const img = await loadImage(imageBuffer);
    const w = Math.max(1, Math.floor(img.width));
    const h = Math.max(1, Math.floor(img.height));
    const canvas = createCanvas(w, h);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0, w, h);
    const imgData = ctx.getImageData(0, 0, w, h);
    const code = jsQR(new Uint8ClampedArray(imgData.data), w, h);
    if (code && code.data) {
      return code.data;
    }
  } catch {
    return null;
  }
  return null;
}

module.exports = { renderPages, findQrJwt, findQrInImage };
