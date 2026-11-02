'use strict';
// Generates synthetic sample PNG and JPG invoice images from data/s4-invoices.json for testing OCR and image uploads.
const fs = require('fs');
const path = require('path');
const { createCanvas } = require('@napi-rs/canvas');

const s4Invoices = JSON.parse(fs.readFileSync(path.join(__dirname, '../data/s4-invoices.json'), 'utf8'));
const sample = s4Invoices[0]; // Clean sample invoice S4-0001

function renderInvoiceCanvas(inv, invoiceNoOverride) {
  const width = 900;
  const height = 650;
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');

  // White background
  ctx.fillStyle = '#FFFFFF';
  ctx.fillRect(0, 0, width, height);

  // Header bar
  ctx.fillStyle = '#0F172A';
  ctx.fillRect(0, 0, width, 65);
  ctx.fillStyle = '#FFFFFF';
  ctx.font = 'bold 26px sans-serif';
  ctx.fillText('TAX INVOICE (SAMPLE)', 36, 42);

  // Body lines in crisp high-contrast black for reliable OCR
  ctx.fillStyle = '#000000';
  ctx.font = '22px sans-serif';

  const lines = [
    `Supplier Name: ${inv.supplierName}`,
    `Supplier GSTIN: ${inv.supplierGstin}`,
    `Buyer GSTIN: ${inv.buyerGstin}`,
    `Invoice No: ${invoiceNoOverride || inv.invoiceNo}`,
    `Invoice Date: ${inv.invoiceDate}`,
    `PO Number: ${inv.poNumber}`,
    `Description: ${inv.description}`,
    `HSN Code: ${inv.hsn}`,
    `Taxable Value: ${Number(inv.taxable).toFixed(2)}`,
    `CGST: ${Number(inv.cgst).toFixed(2)}`,
    `SGST: ${Number(inv.sgst).toFixed(2)}`,
    `Total Amount Payable: ${Number(inv.total).toFixed(2)}`,
  ];

  let y = 115;
  for (const line of lines) {
    ctx.fillText(line, 40, y);
    y += 40;
  }

  return canvas;
}

function generateSampleImages() {
  const outDir = path.join(__dirname, '../samples');
  const pngCanvas = renderInvoiceCanvas(sample, 'IMG-PNG-2026-01');
  fs.writeFileSync(path.join(outDir, 'sample-invoice-clean.png'), pngCanvas.toBuffer('image/png'));

  const jpgCanvas = renderInvoiceCanvas(sample, 'IMG-JPG-2026-02');
  fs.writeFileSync(path.join(outDir, 'sample-invoice-clean.jpg'), jpgCanvas.toBuffer('image/jpeg', 95));
}

if (require.main === module) {
  generateSampleImages();
  console.log('Generated sample-invoice-clean.png and sample-invoice-clean.jpg in /samples');
}

module.exports = { generateSampleImages, renderInvoiceCanvas };
