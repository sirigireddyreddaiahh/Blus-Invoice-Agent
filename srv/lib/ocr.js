'use strict';
// Section 3: OCR extraction module (tesseract.js, English).
// Uses TESSDATA_PATH environment variable (defaults to project root where eng.traineddata resides).
// If OCR language data is missing, returns: "Image could not be read. Enter the fields manually."

const fs = require('fs');
const path = require('path');

const MISSING_OCR_MSG = 'Image could not be read. Enter the fields manually.';
const OCR_WARNING_MSG = 'Read by OCR. Check every field against the image.';

function getTessdataPath() {
  if (process.env.TESSDATA_PATH !== undefined) {
    return process.env.TESSDATA_PATH;
  }
  return path.resolve(__dirname, '../..');
}

function hasTessdataLanguageFile(lang = 'eng') {
  const dir = getTessdataPath();
  if (!dir || typeof dir !== 'string' || !dir.trim()) return false;
  const rawFile = path.join(dir, `${lang}.traineddata`);
  const gzFile = path.join(dir, `${lang}.traineddata.gz`);
  try {
    if (fs.existsSync(rawFile) && fs.statSync(rawFile).size > 1000) return true;
    if (fs.existsSync(gzFile) && fs.statSync(gzFile).size > 1000) return true;
  } catch {
    return false;
  }
  return false;
}

async function runOcr(imageBuffer, options = {}) {
  if (!hasTessdataLanguageFile('eng')) {
    return {
      ok: false,
      text: '',
      confidence: 0,
      words: [],
      error: MISSING_OCR_MSG,
      warning: MISSING_OCR_MSG,
    };
  }

  const langPath = getTessdataPath();
  const hasGz = fs.existsSync(path.join(langPath, 'eng.traineddata.gz'));

  let worker = null;
  try {
    const Tesseract = require('tesseract.js');
    worker = await Tesseract.createWorker('eng', 1, {
      langPath,
      gzip: hasGz,
      cacheMethod: 'none',
    });

    const ret = await worker.recognize(imageBuffer);
    const data = (ret && ret.data) || {};
    const text = String(data.text || '').trim();
    const confidence = typeof data.confidence === 'number' ? Math.round(data.confidence) : 82;

    const words = Array.isArray(data.words)
      ? data.words.map(w => ({
          text: String(w.text || '').trim(),
          confidence: typeof w.confidence === 'number' ? Math.round(w.confidence) : confidence,
        }))
      : [];

    await worker.terminate();
    worker = null;

    if (!text) {
      return {
        ok: false,
        text: '',
        confidence: 0,
        words: [],
        error: MISSING_OCR_MSG,
        warning: MISSING_OCR_MSG,
      };
    }

    return {
      ok: true,
      text,
      confidence,
      words,
      warning: OCR_WARNING_MSG,
    };
  } catch (err) {
    if (worker) {
      try { await worker.terminate(); } catch {}
    }
    return {
      ok: false,
      text: '',
      confidence: 0,
      words: [],
      error: MISSING_OCR_MSG,
      warning: MISSING_OCR_MSG,
    };
  }
}

module.exports = {
  runOcr,
  hasTessdataLanguageFile,
  getTessdataPath,
  MISSING_OCR_MSG,
  OCR_WARNING_MSG,
};
