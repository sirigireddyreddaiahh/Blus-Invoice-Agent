'use strict';
const { GoogleGenAI } = require('@google/genai');

const FAILED_TO_READ_REASON = 'No readable text found. Try a clearer scan or a Fiori CSV export.';
const AI_ASSIST_LABEL = 'Read with AI assist';

let externalCallCounter = 0;
let mockExtractorFn = null;

function setMockExtractor(fn) {
  mockExtractorFn = typeof fn === 'function' ? fn : null;
}

function getExternalCallCount() {
  return externalCallCounter;
}

function resetExternalCallCount() {
  externalCallCounter = 0;
}

function isAllowInvoiceDataToLlm() {
  return String(process.env.ALLOW_INVOICE_DATA_TO_LLM || '').trim().toLowerCase() === 'true';
}

function hasReadableFields(text, fields = {}) {
  const hasText = Boolean(String(text || '').trim());
  const f = fields || {};
  const hasAnyKeyField = Boolean(
    f.invoiceNo ||
    f.SupplierInvoice ||
    f.supplierName ||
    f.InvoicingParty ||
    f.supplierGstin ||
    f.SupplierGSTIN ||
    (f.total !== undefined && f.total !== null && f.total !== '') ||
    (f.InvoiceGrossAmount !== undefined && f.InvoiceGrossAmount !== null && f.InvoiceGrossAmount !== '')
  );
  return hasText && hasAnyKeyField;
}

/**
 * Part 4:
 * - If ALLOW_INVOICE_DATA_TO_LLM is "false" or not set, do NOT send the file to any external service; return ok: false.
 * - If ALLOW_INVOICE_DATA_TO_LLM is "true", call Gemini once with the file on the server to extract
 *   required fields (SupplierInvoice, InvoicingParty, InvoiceGrossAmount, InvoiceDate, GSTIN if present) as JSON only.
 */
async function tryExtractWithGeminiAssist({ buf, fileName = 'invoice.pdf', kind = 'PDF' } = {}) {
  if (!isAllowInvoiceDataToLlm()) {
    return {
      ok: false,
      aiAssistUsed: false,
      reason: FAILED_TO_READ_REASON,
    };
  }

  externalCallCounter++;

  try {
    let rawJson = null;

    if (mockExtractorFn) {
      rawJson = await mockExtractorFn({ buf, fileName, kind });
    } else {
      const apiKey = String(process.env.GEMINI_API_KEY || process.env.API_KEY || '').trim();
      if (!apiKey) {
        return {
          ok: false,
          aiAssistUsed: false,
          reason: FAILED_TO_READ_REASON,
        };
      }

      const mimeType = kind === 'PNG'
        ? 'image/png'
        : (kind === 'JPG' ? 'image/jpeg' : 'application/pdf');
      const modelName = String(process.env.GEMINI_MODEL || 'gemini-3.8-flash').trim().replace(/^models\//, '');

      const ai = new GoogleGenAI({
        apiKey,
        httpOptions: {
          headers: { 'User-Agent': 'aistudio-build' },
        },
      });

      const prompt = 'Extract the invoice fields from this document and return JSON only with keys: SupplierInvoice, InvoicingParty, InvoiceGrossAmount, InvoiceDate, GSTIN. Use empty string if a field is not visible.';
      const response = await ai.models.generateContent({
        model: modelName,
        contents: [
          {
            inlineData: {
              mimeType,
              data: Buffer.isBuffer(buf) ? buf.toString('base64') : String(buf || ''),
            },
          },
          prompt,
        ],
        config: {
          responseMimeType: 'application/json',
        },
      });

      const textOut = String((response && response.text) || '').trim();
      const cleaned = textOut.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
      rawJson = JSON.parse(cleaned);
    }

    if (!rawJson || typeof rawJson !== 'object') {
      return {
        ok: false,
        aiAssistUsed: false,
        reason: FAILED_TO_READ_REASON,
      };
    }

    const supplierInvoice = String(rawJson.SupplierInvoice || rawJson.invoiceNo || '').trim();
    const invoicingParty = String(rawJson.InvoicingParty || rawJson.supplierName || '').trim();
    const rawAmount = rawJson.InvoiceGrossAmount !== undefined && rawJson.InvoiceGrossAmount !== null && rawJson.InvoiceGrossAmount !== ''
      ? rawJson.InvoiceGrossAmount
      : rawJson.total;
    const amountNum = rawAmount !== undefined && rawAmount !== null && rawAmount !== ''
      ? Number(String(rawAmount).replace(/,/g, '').trim())
      : NaN;
    const invoiceDate = String(rawJson.InvoiceDate || rawJson.invoiceDate || '').trim();
    const gstin = String(rawJson.GSTIN || rawJson.SupplierGSTIN || rawJson.supplierGstin || '').trim().toUpperCase();

    // Validate required fields (SupplierInvoice, InvoicingParty, InvoiceGrossAmount)
    if (!supplierInvoice || !invoicingParty || Number.isNaN(amountNum) || amountNum <= 0) {
      return {
        ok: false,
        aiAssistUsed: false,
        reason: FAILED_TO_READ_REASON,
      };
    }

    const fields = {
      SupplierInvoice: supplierInvoice,
      InvoicingParty: invoicingParty,
      InvoiceGrossAmount: amountNum,
      InvoiceDate: invoiceDate || new Date().toISOString().slice(0, 10),
      SupplierGSTIN: gstin || undefined,
      invoiceNo: supplierInvoice,
      supplierName: invoicingParty,
      total: amountNum,
      invoiceDate: invoiceDate || new Date().toISOString().slice(0, 10),
      supplierGstin: gstin || undefined,
      aiAssistUsed: true,
      readWithAiAssist: true,
    };

    return {
      ok: true,
      aiAssistUsed: true,
      label: AI_ASSIST_LABEL,
      aiAssistLabel: AI_ASSIST_LABEL,
      fields,
    };
  } catch (_err) {
    return {
      ok: false,
      aiAssistUsed: false,
      reason: FAILED_TO_READ_REASON,
    };
  }
}

module.exports = {
  FAILED_TO_READ_REASON,
  AI_ASSIST_LABEL,
  isAllowInvoiceDataToLlm,
  hasReadableFields,
  tryExtractWithGeminiAssist,
  setMockExtractor,
  getExternalCallCount,
  resetExternalCallCount,
};

