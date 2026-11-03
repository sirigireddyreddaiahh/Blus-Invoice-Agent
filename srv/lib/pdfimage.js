'use strict';
// Uses jsqr to scan rendered PDF pages or uploaded PNG/JPG images for QR codes.
const path = require('path');
const jsQR = require('jsqr');
try {
  const { Path2D, ImageData } = require('@napi-rs/canvas');
  if (Path2D && !global.Path2D) global.Path2D = Path2D;
  if (ImageData && !global.ImageData) global.ImageData = ImageData;
} catch {}

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

async function renderPages(pdfBuffer, options = {}) {
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
    const maxPages = Math.min(doc.numPages, options.maxPages || 2);
    const pages = [];

    for (let i = 1; i <= maxPages; i++) {
      const page = await doc.getPage(i);
      const viewport = page.getViewport({ scale: options.scale || 2.0 });
      try {
        const { createCanvas } = require('@napi-rs/canvas');
        const w = Math.max(1, Math.floor(viewport.width));
        const h = Math.max(1, Math.floor(viewport.height));
        const canvas = createCanvas(w, h);
        const ctx = canvas.getContext('2d');
        await page.render({ canvasContext: ctx, viewport }).promise;
        const imgData = ctx.getImageData(0, 0, w, h);
        pages.push({
          width: imgData.width || w,
          height: imgData.height || h,
          data: new Uint8ClampedArray(imgData.data),
          png: canvas.toBuffer('image/png'),
        });
      } catch {
        // Fallback when canvas render fails
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
