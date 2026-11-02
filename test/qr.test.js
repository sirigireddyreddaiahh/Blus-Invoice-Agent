'use strict';
process.env.ENABLE_ALL_RULES = 'true';
// Reads an IRN-style QR code from a PDF page, verifies its RS256 signature, and runs AP-01 on it.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const QRCode = require('qrcode');
const { PDFDocument, StandardFonts } = require('pdf-lib');
const { renderPages, findQrJwt } = require('../srv/lib/pdfimage');
const { verifyIrpJwt } = require('../srv/rules/rules');
const { runRules } = require('../srv/rules/engine');
const masters = require('../data/masters.json');

const b64u = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
function signJwt(payload, privateKey) {
  const h = b64u({ alg: 'RS256', typ: 'JWT' }), p = b64u(payload);
  const sig = crypto.createSign('RSA-SHA256').update(h + '.' + p).end().sign(privateKey).toString('base64url');
  return `${h}.${p}.${sig}`;
}
async function invoicePdf(lines, qrText) {
  const doc = await PDFDocument.create();
  const page = doc.addPage([595, 842]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  let y = 780;
  for (const ln of lines) { page.drawText(ln, { x: 50, y, size: 11, font }); y -= 18; }
  if (qrText) {
    const png = await QRCode.toBuffer(qrText, { errorCorrectionLevel: 'L', margin: 4, scale: 8 });
    page.drawImage(await doc.embedPng(png), { x: 60, y: 380, width: 300, height: 300 });
  }
  return Buffer.from(await doc.save());
}

const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const pem = publicKey.export({ type: 'spki', format: 'pem' });
const payload = {
  SellerGstin: '37AAFCS2201L1ZG', BuyerGstin: '37AABCB1001K1Z7', DocNo: 'SSFS/2026/0412',
  DocDt: '20/10/2026', TotInvVal: 59000, Irn: 'a'.repeat(64),
};
const jwt = signJwt(payload, privateKey);
const lines = ['TAX INVOICE', 'Invoice No: SSFS/2026/0412', 'Total Amount: 59000.00'];

test('a PDF without a QR code gives null', async () => {
  const pages = await renderPages(await invoicePdf(lines, null), { maxPages: 1, scale: 2 });
  assert.equal(findQrJwt(pages), null);
});

test('the QR on a PDF page is read, and its IRP signature verifies', async () => {
  const pages = await renderPages(await invoicePdf(lines, jwt), { maxPages: 1, scale: 2 });
  const found = findQrJwt(pages);
  assert.equal(found, jwt);
  const v = verifyIrpJwt(found, pem);
  assert.equal(v.ok, true);
  assert.equal(v.payload.TotInvVal, 59000);
});

test('AP-01 passes for the QR read from the PDF, and holds a QR that does not match the invoice', async () => {
  const pages = await renderPages(await invoicePdf(lines, jwt), { maxPages: 1, scale: 2 });
  const found = findQrJwt(pages);
  const inv = {
    supplierGstin: '37AAFCS2201L1ZG', buyerGstin: '37AABCB1001K1Z7', invoiceNo: 'SSFS/2026/0412',
    invoiceDate: '2026-10-20', total: 59000, taxable: 50000, cgst: 4500, sgst: 4500, qrJwt: found,
  };
  const ctx = { masters, posted: [], batch: [], earlier: [], irpPublicKeyPem: pem };
  assert.equal(runRules(inv, ctx).results.find(r => r.id === 'AP-01').tier, 'PASS');
  const wrongTotal = { ...inv, total: 1000 };
  assert.equal(runRules(wrongTotal, ctx).results.find(r => r.id === 'AP-01').tier, 'HOLD');
});
