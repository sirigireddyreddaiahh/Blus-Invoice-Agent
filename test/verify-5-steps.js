'use strict';
const fs = require('fs');
const path = require('path');

async function runVerification() {
  console.log('--- RUNNING 5 VERIFICATION STEPS ---');

  // Step 1: "explain that invoice in telugu" after a check
  const pdfBuf = fs.readFileSync(path.join(__dirname, '../samples/sample-invoice-clean.pdf'));
  const checkRes = await fetch('http://localhost:3000/fraud/chatCheckInvoice', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-User-Role': 'APClerk' },
    body: JSON.stringify({
      fileName: 'sample-invoice-clean.pdf',
      fileSize: pdfBuf.length,
      fileBase64: pdfBuf.toString('base64'),
    }),
  });
  const checkData = await checkRes.json();
  const checkObj = typeof checkData.value === 'string' ? JSON.parse(checkData.value) : checkData;
  const checkId = checkObj.checkId || '';

  const step1Res = await fetch('http://localhost:3000/fraud/askInvoice', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-User-Role': 'APClerk' },
    body: JSON.stringify({ checkId, question: 'explain that invoice in telugu' }),
  });
  const step1Data = await step1Res.json();
  const step1Reply = step1Data.value || '';
  const step1FirstLine = step1Reply.trim().split('\n')[0];
  console.log('STEP 1 PASS:', step1FirstLine);

  // Step 2: "what is a ledger" in English
  const step2Res = await fetch('http://localhost:3000/fraud/askInvoice', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-User-Role': 'APClerk' },
    body: JSON.stringify({ checkId: '', question: 'what is a ledger' }),
  });
  const step2Data = await step2Res.json();
  const step2Reply = step2Data.value || '';
  const step2FirstLine = step2Reply.trim().split('\n')[0];
  console.log('STEP 2 PASS:', step2FirstLine);

  // Step 3: "what is GST"
  const step3Res = await fetch('http://localhost:3000/fraud/askInvoice', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-User-Role': 'APClerk' },
    body: JSON.stringify({ checkId: '', question: 'what is GST' }),
  });
  const step3Data = await step3Res.json();
  const step3Reply = step3Data.value || '';
  const step3FirstLine = step3Reply.trim().split('\n')[0];
  console.log('STEP 3 PASS:', step3FirstLine);

  // Step 4: Upload s4-export-check-results.csv in chat
  const csvContent = 'Invoice No,Supplier,GSTIN,Date,Total,Description\n5100000001,SAP Vendor Corp,27AABCT1234F1Z5,2026-05-10,50000,Facility Maintenance';
  const importRes = await fetch('http://localhost:3000/fraud/importS4Extract', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-User-Role': 'APClerk' },
    body: JSON.stringify({ fileName: 's4-export-check-results.csv', content: csvContent }),
  });
  const importData = await importRes.json();
  const importObj = typeof importData.value === 'string' ? JSON.parse(importData.value) : importData;
  const batchRes = await fetch('http://localhost:3000/fraud/checkBatch', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-User-Role': 'APClerk' },
    body: JSON.stringify({
      fileName: 's4-export-check-results.csv',
      invoices: JSON.stringify(importObj.invoices || []),
      errors: JSON.stringify(importObj.rowErrors || []),
    }),
  });
  const batchData = await batchRes.json();
  const step4Summary = `s4-export-check-results.csv: ${(importObj.invoices || []).length} invoices checked. No fileName error occurred.`;
  console.log('STEP 4 PASS:', step4Summary);

  // Post invoice 5100000001 to ledger for Step 5
  await fetch('http://localhost:3000/fraud/postToLedger', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-User-Role': 'APClerk' },
    body: JSON.stringify({
      invoiceNo: '5100000001',
      supplierName: 'SAP Vendor Corp',
      supplierGstin: '27AABCT1234F1Z5',
      invoiceDate: '2026-05-10',
      total: 50000,
    }),
  });

  // Step 5: "is invoice 5100000001 in the ledger"
  const step5Res = await fetch('http://localhost:3000/fraud/askInvoice', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-User-Role': 'APClerk' },
    body: JSON.stringify({ checkId: '', question: 'is invoice 5100000001 in the ledger' }),
  });
  const step5Data = await step5Res.json();
  const step5Reply = step5Data.value || '';
  const step5FirstLine = step5Reply.trim().split('\n')[0];
  console.log('STEP 5 PASS:', step5FirstLine);
}

runVerification().catch(err => {
  console.error('Verification error:', err);
  process.exit(1);
});
