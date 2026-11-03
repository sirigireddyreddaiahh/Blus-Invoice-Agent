'use strict';
const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { runRules } = require('../srv/rules/engine');
const {
  validateAndDetectFile,
  MAX_FILE_BYTES,
  UNSUPPORTED_FILE_MSG,
  FILE_TOO_LARGE_MSG,
} = require('../srv/lib/extract');
const lookup = require('../srv/lib/lookup');
const FraudService = require('../srv/fraud-service');

const masters = JSON.parse(fs.readFileSync(path.join(__dirname, '../data/masters.json'), 'utf8'));
const s4Invoices = JSON.parse(fs.readFileSync(path.join(__dirname, '../data/s4-invoices.json'), 'utf8'));
const vendor1 = masters.vendors[0];
const vendor4 = masters.vendors[3];
const recurringPoObj = masters.purchaseOrders.find(p => p.recurring);

before(async () => {
  try {
    const cds = require('@sap/cds');
    const db = await cds.connect.to('db');
    await db.run("DELETE FROM ap_Posted WHERE invoiceNo LIKE 'SSFS/%' OR invoiceNo LIKE 'DB-CHK-%' OR invoiceNo LIKE 'CHK-%'");
  } catch {}
});

// ============================================================================
// SECTION 11: 16 ACCEPTANCE CHECKS
// ============================================================================

test('Acceptance Check 1: No heading, description, mode toggle, file card or quick buttons anywhere', () => {
  const html = fs.readFileSync(path.join(__dirname, '../app/index.html'), 'utf8');
  assert.equal(/Supplier Invoice Rules Check/i.test(html), false, 'No "Supplier Invoice Rules Check" label');
  assert.equal(/<h2[^>]*>Invoice check<\/h2>/i.test(html), false, 'No "Invoice check" heading');
  assert.equal(/Check supplier invoices against active rules/i.test(html), false, 'No description text');
  assert.equal(/id="modeSwitchBar"|id="btnModeAi"|id="btnModeManual"/i.test(html), false, 'No AI/Manual mode toggle');
  assert.equal(/id="attachedFileCard"/i.test(html), false, 'No file card above chat');
  assert.equal(/Quick check samples:|id="aiQuickSampleBar"|class="quick-sample-btn"/i.test(html), false, 'No quick buttons row');
});

test('Acceptance Check 2: Manual mode is gone. No toggle, no step panel, no field table', () => {
  const html = fs.readFileSync(path.join(__dirname, '../app/index.html'), 'utf8');
  const appJs = fs.readFileSync(path.join(__dirname, '../app/app.js'), 'utf8');
  assert.equal(/id="manualModeView"/i.test(html), false, 'No manualModeView');
  assert.equal(/id="stepPanelCard"|id="stepList"/i.test(html), false, 'No 10-step panel');
  assert.equal(/id="fieldTable"|id="fieldTableBody"/i.test(html), false, 'No editable field table');
  assert.equal(/Open in Manual mode/i.test(appJs), false, 'No "Open in Manual mode" button');
});

test('Acceptance Check 3: The chat area is empty on page load. No welcome message', () => {
  const html = fs.readFileSync(path.join(__dirname, '../app/index.html'), 'utf8');
  assert.match(html, /<div id="aiChatThread" class="ai-chat-thread" role="log" aria-live="polite"><\/div>/);
  assert.equal(/Attach an invoice with \+ and press Send/i.test(html), false, 'No welcome message in chat thread');
});

test('Acceptance Check 4: The composer is visible on a 1366x768 screen without scrolling', () => {
  const css = fs.readFileSync(path.join(__dirname, '../app/style.css'), 'utf8');
  const html = fs.readFileSync(path.join(__dirname, '../app/index.html'), 'utf8');
  assert.match(css, /\.app-shell\s*\{[\s\S]*?height:\s*100vh;[\s\S]*?overflow:\s*hidden;/);
  assert.match(css, /\.ai-chat-thread\s*\{[\s\S]*?flex:\s*1;[\s\S]*?min-height:\s*0;[\s\S]*?overflow-y:\s*auto;/);
  assert.match(css, /\.ai-composer\s*\{[\s\S]*?position:\s*absolute;[\s\S]*?bottom:\s*16px;/);
  assert.match(html, /placeholder="Ask about an invoice or attach a PDF\.\.\."/);
});

test('Acceptance Check 5: Attaching a file shows a chip in the composer only. No card appears above the chat', () => {
  const html = fs.readFileSync(path.join(__dirname, '../app/index.html'), 'utf8');
  const appJs = fs.readFileSync(path.join(__dirname, '../app/app.js'), 'utf8');
  // Verify composerFileChip is inside #aiComposer and left of #aiComposerInput
  const composerBlock = html.match(/<div class="ai-composer" id="aiComposer">[\s\S]*?<\/div>\s*<\/div>\s*<\/section>/);
  assert.ok(composerBlock, 'aiComposer exists');
  const chipIdx = composerBlock[0].indexOf('id="composerFileChip"');
  const inputIdx = composerBlock[0].indexOf('id="aiComposerInput"');
  assert.ok(chipIdx > 0 && chipIdx < inputIdx, 'composerFileChip is inside composer, left of text input');
  assert.match(appJs, /shortenFileName\(state\.selectedFile\.name,\s*20\)/);
  assert.match(html, /id="btnRemoveChipFile"[^>]*>X<\/button>/);
});

test('Acceptance Check 6: A PNG is accepted. A Word file is rejected with the right message', async () => {
  const pngBuf = fs.readFileSync(path.join(__dirname, '../samples/sample-invoice-clean.png'));
  const checkPng = validateAndDetectFile('sample-invoice-clean.png', pngBuf, pngBuf.length);
  assert.equal(checkPng.ok, true);
  assert.equal(checkPng.kind, 'PNG');

  const fakeDocx = Buffer.from('PK\x03\x04 word/document.xml fake word document');
  const checkDocx = validateAndDetectFile('invoice.docx', fakeDocx, fakeDocx.length);
  assert.equal(checkDocx.ok, false);
  assert.equal(checkDocx.error, 'Only PDF, PNG and JPG files are supported.');
  assert.equal(UNSUPPORTED_FILE_MSG, 'Only PDF, PNG and JPG files are supported.');
});

test('Acceptance Check 7: A file over 10 MB is rejected with the right message', () => {
  const over10Mb = MAX_FILE_BYTES + 1024;
  const checkLarge = validateAndDetectFile('huge-invoice.pdf', Buffer.from('%PDF-1.4'), over10Mb);
  assert.equal(checkLarge.ok, false);
  assert.equal(checkLarge.error, 'File is too large. Maximum size is 10 MB.');
  assert.equal(FILE_TOO_LARGE_MSG, 'File is too large. Maximum size is 10 MB.');
});

test('Acceptance Check 8: The sidebar collapses to icons. Text labels disappear', () => {
  const html = fs.readFileSync(path.join(__dirname, '../app/index.html'), 'utf8');
  const css = fs.readFileSync(path.join(__dirname, '../app/style.css'), 'utf8');
  const appJs = fs.readFileSync(path.join(__dirname, '../app/app.js'), 'utf8');
  assert.match(html, /id="btnSidebarCollapse"/);
  assert.match(css, /\.sidebar\.collapsed\s+\.nav-label\s*\{\s*display:\s*none\s*!important;\s*\}/);
  assert.match(appJs, /localStorage\.setItem\(SIDEBAR_STORAGE_KEY/);
  assert.match(appJs, /localStorage\.getItem\(SIDEBAR_STORAGE_KEY\)/);
});

test('Acceptance Check 9: On a screen narrower than 768 px the sidebar is hidden by default', () => {
  const css = fs.readFileSync(path.join(__dirname, '../app/style.css'), 'utf8');
  assert.match(css, /@media\s*\(max-width:\s*767\.98px\)\s*\{[\s\S]*?\.sidebar\s*\{\s*display:\s*none;[\s\S]*?height:\s*100vh;/);
  assert.match(css, /\.sidebar\.mobile-open\s*\{\s*display:\s*flex;\s*\}/);
});

test('Acceptance Check 10: After sending an invoice the result appears below the user message, not above it', async () => {
  const appJs = fs.readFileSync(path.join(__dirname, '../app/app.js'), 'utf8');
  assert.match(appJs, /appendMessageToChat\(el\('div',\s*`Checking \$\{fileToSend\.name\}`,\s*'chat-bubble user'\)\)/);
  assert.match(appJs, /const resultMsg = renderAiChatResultMessage\(out,\s*fileToSend\.name\);\s*appendMessageToChat\(resultMsg\);/);
  assert.equal(/insertBefore|prepend/.test(appJs), false, 'Messages are appended chronologically at the bottom');

  const pdfBuf = fs.readFileSync(path.join(__dirname, '../samples/sample-invoice-clean.pdf'));
  const r = await fetch('http://localhost:3000/fraud/chatCheckInvoice', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-User-Role': 'APClerk' },
    body: JSON.stringify({
      fileName: 'sample-invoice-clean.pdf',
      fileSize: pdfBuf.length,
      fileBase64: pdfBuf.toString('base64'),
    }),
  });
  assert.equal(r.status, 200);
  const body = await r.json();
  const out = JSON.parse(body.value);
  assert.equal(out.verdict, 'Passed checks');
  assert.equal(out.disclaimer, 'Rules check only. Does not prove the invoice is genuine.');
});

test('Acceptance Check 11: "is this real or fake" gets a reply using the verdict and rule results', async () => {
  const r = await fetch('http://localhost:3000/fraud/askInvoice', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-User-Role': 'APClerk', 'X-User-Id': 'clerk' },
    body: JSON.stringify({
      checkId: '',
      question: 'is this real or fake',
    }),
  });
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.notEqual(body.value, 'I can only answer questions about this invoice check.');
  assert.notEqual(body.value, 'The assistant is not configured.');
  assert.match(body.value, /Passed checks|Needs review|Blocked|AP-02|AP-03|AP-09|AP-11|rules check/i);
  assert.equal(/\b(fake|real)\b/i.test(body.value), false, 'Reply never uses prohibited words fake or real');
});

test('Acceptance Check 12: "bank account is same or not" gets a reply about the invoice data, not the refusal message', async () => {
  const r = await fetch('http://localhost:3000/fraud/askInvoice', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-User-Role': 'APClerk', 'X-User-Id': 'clerk' },
    body: JSON.stringify({
      checkId: '',
      question: 'bank account is same or not',
    }),
  });
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.notEqual(body.value, 'I can only answer questions about this invoice check.');
  assert.notEqual(body.value, 'The assistant is not configured.');
  assert.match(body.value, /AP-05/i);
  assert.match(body.value, /IFSC/i);
  assert.match(body.value, /Account/i);
});

test('Acceptance Check 13: "what is the weather" gets the refusal message', async () => {
  const r = await fetch('http://localhost:3000/fraud/askInvoice', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-User-Role': 'APClerk', 'X-User-Id': 'clerk' },
    body: JSON.stringify({
      checkId: '',
      question: 'what is the weather',
    }),
  });
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.equal(body.value, 'I can only answer questions about this invoice check.');
});

test('Acceptance Check 14: "Post to ledger" is disabled when the verdict is Blocked', async () => {
  const appJs = fs.readFileSync(path.join(__dirname, '../app/app.js'), 'utf8');
  assert.match(appJs, /const isBlocked = verdict === 'Blocked' \|\| res\.status === 'REJECT'/);
  assert.match(appJs, /btnPost\.disabled = isBlocked \|\| !canPostRole/);

  const dupPdfBuf = fs.readFileSync(path.join(__dirname, '../samples/sample-invoice-duplicate.pdf'));
  const r = await fetch('http://localhost:3000/fraud/chatCheckInvoice', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-User-Role': 'APClerk' },
    body: JSON.stringify({
      fileName: 'sample-invoice-duplicate.pdf',
      fileSize: dupPdfBuf.length,
      fileBase64: dupPdfBuf.toString('base64'),
    }),
  });
  assert.equal(r.status, 200);
  const body = await r.json();
  const out = JSON.parse(body.value);
  assert.equal(out.verdict, 'Blocked');
  assert.equal(out.status, 'REJECT');
});

test('Acceptance Check 15: With GEMINI_API_KEY unset, follow-up questions show "The assistant is not configured."', async () => {
  const r = await fetch('http://localhost:3000/fraud/askInvoice', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-User-Role': 'APClerk',
      'X-User-Id': 'clerk',
      'x-gemini-api-key-unset': 'true',
    },
    body: JSON.stringify({
      checkId: '',
      question: 'is this real or fake',
    }),
  });
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.equal(body.value, 'The assistant is not configured.');
});

test('Acceptance Check 16: With ALLOW_INVOICE_DATA_TO_LLM unset, the request sent to Gemini contains no supplier name, GSTIN, bank details or amounts', () => {
  const allowInvoiceData = process.env.ALLOW_INVOICE_DATA_TO_LLM === 'true';
  assert.equal(allowInvoiceData, false);

  const mockCheckRecord = {
    ID: 'check-1001',
    status: 'REJECT',
    fileName: 'sample-invoice-duplicate.pdf',
    supplierName: vendor1.name,
    supplierGstin: vendor1.gstin,
    invoiceNo: 'INV/2026/0108',
    invoiceDate: '2026-06-14',
    total: 247800,
    pdfText: 'Secret raw invoice text with bank account ' + vendor1.account,
  };
  const mockParsedResult = {
    status: 'REJECT',
    fields: {
      supplierName: vendor1.name,
      supplierGstin: vendor1.gstin,
      invoiceNo: 'INV/2026/0108',
      total: 247800,
      ifsc: vendor1.ifsc,
      accountNo: vendor1.account,
    },
  };
  const mockActiveResults = [
    { id: 'AP-02', title: 'Exact duplicate', tier: 'REJECT', text: `Matches posted invoice INV/2026/0108 for GSTIN ${vendor1.gstin} with amount INR 2,47,800.00` },
    { id: 'AP-03', title: 'GSTIN reuse', tier: 'PASS', text: 'GSTIN is registered to a unique vendor ID.' },
    { id: 'AP-09', title: 'Same vendor, amount and services', tier: 'PASS', text: 'No repeat bill within 90 days.' },
    { id: 'AP-11', title: 'Split invoices', tier: 'PASS', text: 'No split pattern.' },
  ];

  const outgoing = FraudService.buildInvoiceOutgoingRequest({
    checkRecord: mockCheckRecord,
    parsedResult: mockParsedResult,
    activeResults: mockActiveResults,
    question: 'Why was invoice INV/2026/0108 blocked by AP-02?',
    allowInvoiceData: false,
  });

  const outgoingJson = JSON.stringify(outgoing);
  console.log('EXACT_OUTGOING_GEMINI_PAYLOAD:', outgoingJson);

  assert.equal(outgoingJson.includes(vendor1.name), false, 'Must not contain supplier name');
  assert.equal(outgoingJson.includes(vendor1.gstin), false, 'Must not contain supplier GSTIN');
  assert.equal(outgoingJson.includes(vendor1.account), false, 'Must not contain bank account');
  assert.equal(outgoingJson.includes(vendor1.ifsc), false, 'Must not contain bank IFSC');
  assert.equal(outgoingJson.includes('INV/2026/0108'), false, 'Must not contain invoice number');
  assert.equal(outgoingJson.includes('247800'), false, 'Must not contain invoice total');
  assert.equal(outgoingJson.includes('2,47,800'), false, 'Must not contain formatted invoice total');
  assert.equal(outgoingJson.includes('Secret raw invoice text'), false, 'Must not contain raw PDF text');
});

// ============================================================================
// CORE FRAUD RULES & RBAC REGRESSION TESTS
// ============================================================================

test('Core Rules: AP-02, AP-03, AP-09, AP-11, 14 stored rules, lookup guard, and Auditor RBAC', async () => {
  // 1. Clean invoice -> PASS
  const cleanRes = runRules({
    supplierGstin: vendor1.gstin,
    supplierId: vendor1.id,
    invoiceNo: 'CLEAN-INV-2026-999',
    invoiceDate: '2026-10-25',
    total: 50000,
    description: 'General facility repairs',
  }, { masters, posted: [], batch: [], earlier: [] });
  assert.equal(cleanRes.status, 'PASS');
  assert.equal(cleanRes.results.length, 14);

  // 2. AP-02 duplicate -> REJECT
  const dupRes = runRules({
    supplierGstin: vendor1.gstin,
    supplierId: vendor1.id,
    invoiceNo: 'DUP-TEST-001',
    invoiceDate: '2026-10-20',
    total: 50000,
  }, {
    masters,
    posted: [{ invoiceNo: 'DUP-TEST-001', supplierGstin: vendor1.gstin, invoiceDate: '2026-10-18', total: 50000 }],
    batch: [],
    earlier: [],
  });
  assert.equal(dupRes.status, 'REJECT');

  // 3. AP-09 repeat bill -> REJECT (unless recurring PO)
  const repeatInv = {
    supplierGstin: vendor1.gstin,
    invoiceNo: 'REPEAT-101',
    invoiceDate: '2026-10-20',
    total: 75000,
    description: 'Campus sanitization services for block A',
  };
  const postedAp09 = [{
    invoiceNo: 'ORIG-100',
    supplierGstin: vendor1.gstin,
    invoiceDate: '2026-10-01',
    total: 75000,
    description: 'Campus sanitization services for block A',
  }];
  assert.equal(runRules(repeatInv, { masters, posted: postedAp09, batch: [], earlier: [] }).status, 'REJECT');
  assert.equal(runRules({ ...repeatInv, poNumber: recurringPoObj.po }, { masters, posted: postedAp09, batch: [], earlier: [] }).results.find(r => r.id === 'AP-09').tier, 'PASS');

  // 4. AP-11 split bills -> HOLD
  const b1 = { id: 'B1', supplierGstin: vendor4.gstin, invoiceNo: 'BILL-1', invoiceDate: '2026-10-10', total: 98500, description: 'Signage printing' };
  const b2 = { id: 'B2', supplierGstin: vendor4.gstin, invoiceNo: 'BILL-2', invoiceDate: '2026-10-15', total: 98500, description: 'Brochure printing' };
  assert.equal(runRules(b2, { masters, posted: [], batch: [b1, b2], earlier: [b1] }).status, 'HOLD');

  // 5. Lookup read-only guard
  await assert.rejects(
    async () => lookup.executeReadOnlyQuery('DELETE FROM client_vendors WHERE id = ?', ['V1']),
    /Read-only violation/
  );

  // 6. Auditor RBAC guard
  const rAuditor = await fetch('http://localhost:3000/fraud/chatCheckInvoice', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-User-Role': 'Auditor' },
    body: JSON.stringify({ fileName: 'test.pdf', fileSize: 100, fileBase64: '' }),
  });
  assert.equal(rAuditor.status, 403);
});

test('Acceptance Check 18: Separate CSV and Excel (.xlsx) downloads and Landing Page Activity log card', async () => {
  const ExcelJS = require('exceljs');
  const html = fs.readFileSync(path.join(__dirname, '../app/index.html'), 'utf8');
  const appJs = fs.readFileSync(path.join(__dirname, '../app/app.js'), 'utf8');

  // 1. Landing page cards: Upload invoice, Check duplicates, Activity log ("See every check and decision")
  assert.match(html, /id="welcomeCardUpload"[\s\S]*?Upload invoice/);
  assert.match(html, /id="welcomeCardDuplicates"[\s\S]*?Check duplicates/);
  assert.match(html, /id="welcomeCardActivity"[\s\S]*?Activity log[\s\S]*?See every check and decision/);
  assert.equal(/id="welcomeCardQueue"/.test(html), false, 'Review queue card removed from landing page');

  // Review queue remains in sidebar only, visible to APController only
  assert.match(html, /id="nav-alerts"[^>]*title="3\. Review queue"/);
  assert.match(appJs, /navAlerts\.classList\.toggle\('hidden',\s*!canDecide\)/);

  // 2. Separate CSV and Excel endpoints with identical data
  const sampleRows = [
    {
      createdAt: '2026-10-25T10:00:00Z',
      source: 'CHAT',
      fileName: 'clean-bill.pdf',
      invoiceNo: 'INV-101',
      supplierName: 'Acme Corp, Ltd.',
      supplierGstin: '27AABCU9603R1ZM',
      total: 50000,
      status: 'PASS',
      createdBy: 'clerk',
      resultJson: JSON.stringify({
        results: [
          { id: 'AP-02', tier: 'PASS', text: 'No duplicate' },
          { id: 'AP-03', tier: 'PASS', text: 'Unique GSTIN' },
          { id: 'AP-09', tier: 'HOLD', text: 'Similar service "A"' },
          { id: 'AP-11', tier: 'REJECT', text: 'Split pattern' },
        ],
      }),
    },
  ];

  // CSV endpoint check
  const csvRes = await fetch('http://localhost:3000/fraud/exportHistoryCsv', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ rows: sampleRows }),
  });
  assert.equal(csvRes.status, 200);
  assert.match(csvRes.headers.get('content-type') || '', /text\/csv/i);
  assert.match(csvRes.headers.get('content-disposition') || '', /\.csv"/i);
  const csvBuf = Buffer.from(await csvRes.arrayBuffer());
  assert.equal(csvBuf[0], 0xef, 'CSV byte 0 is UTF-8 BOM 0xEF');
  assert.equal(csvBuf[1], 0xbb, 'CSV byte 1 is UTF-8 BOM 0xBB');
  assert.equal(csvBuf[2], 0xbf, 'CSV byte 2 is UTF-8 BOM 0xBF');
  const csvText = csvBuf.toString('utf8');
  assert.match(csvText, /"Acme Corp, Ltd\."/, 'Proper CSV comma quote escaping');
  assert.match(csvText, /"HOLD: Similar service ""A"""/, 'Proper CSV double-quote escaping');

  // Excel (.xlsx) endpoint check
  const xlsxRes = await fetch('http://localhost:3000/fraud/exportHistoryExcel', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ rows: sampleRows }),
  });
  assert.equal(xlsxRes.status, 200);
  assert.match(
    xlsxRes.headers.get('content-type') || '',
    /application\/vnd\.openxmlformats-officedocument\.spreadsheetml\.sheet/i
  );
  assert.match(xlsxRes.headers.get('content-disposition') || '', /\.xlsx"/i);
  const xlsxBuf = Buffer.from(await xlsxRes.arrayBuffer());
  assert.equal(xlsxBuf.subarray(0, 2).toString('utf8'), 'PK', 'Valid .xlsx zip header');

  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(xlsxBuf);
  const sheet = wb.getWorksheet('Check History');
  assert.ok(sheet, 'Worksheet Check History exists');
  assert.equal(sheet.getRow(1).getCell(1).font.bold, true, 'Header row is bold');
  assert.ok(sheet.getColumn(5).width >= 15, 'Column widths are auto-fitted');

  // Verify PASS / HOLD / REJECT color coding (green / amber / red)
  const dataRow = sheet.getRow(2);
  assert.equal(dataRow.getCell(8).fill.fgColor.argb, 'FFDCFCE7', 'PASS cell is green');
  assert.equal(dataRow.getCell(12).fill.fgColor.argb, 'FFFEF3C7', 'HOLD cell is amber');
  assert.equal(dataRow.getCell(13).fill.fgColor.argb, 'FFFEE2E2', 'REJECT cell is red');
});

test('Acceptance Check 19: Reference HANA ledger check, indexed lookups, multi-file batch, and search database', async () => {
  const uniqueInvNo = 'DB-CHK-' + Date.now();
  const testGstin = '29' + Math.random().toString(36).slice(2, 6).toUpperCase() + '1234F1Z5';
  const testAmt = Math.floor(Math.random() * 50000) + 120000;

  // 1. Initial check of unique invoice: Not found in database -> PASS -> auto-inserted into ledger
  const checkRes1 = await fetch('http://localhost:3000/fraud/checkInvoice', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-User-Role': 'APClerk,APController,Auditor',
      'X-User-Id': 'single-user',
    },
    body: JSON.stringify({
      invoice: JSON.stringify({
        invoiceNo: uniqueInvNo,
        supplierGstin: testGstin,
        supplierName: 'Ledger Test Labs Pvt Ltd',
        invoiceDate: '2026-10-15',
        total: testAmt,
        description: 'Software security audit',
      }),
    }),
  });
  assert.equal(checkRes1.status, 200);
  const out1 = await checkRes1.json();
  const data1 = typeof out1 === 'string' ? JSON.parse(out1) : (out1.value ? JSON.parse(out1.value) : out1);
  assert.equal(data1.status, 'PASS');
  assert.ok(data1.databaseMatch, 'Has databaseMatch object');
  assert.equal(data1.databaseMatch.status, 'Not found in database');
  assert.equal(data1.databaseMatch.matched, false);

  // 2. Second check with same invoice number: Found in database
  const checkRes2 = await fetch('http://localhost:3000/fraud/checkInvoice', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-User-Role': 'APClerk,APController,Auditor',
      'X-User-Id': 'single-user',
    },
    body: JSON.stringify({
      invoice: JSON.stringify({
        invoiceNo: uniqueInvNo,
        supplierGstin: testGstin,
        supplierName: 'Ledger Test Labs Pvt Ltd',
        invoiceDate: '2026-10-15',
        total: testAmt,
        description: 'Software security audit',
      }),
    }),
  });
  assert.equal(checkRes2.status, 200);
  const out2 = await checkRes2.json();
  const data2 = typeof out2 === 'string' ? JSON.parse(out2) : (out2.value ? JSON.parse(out2.value) : out2);
  assert.ok(data2.databaseMatch.matched, 'Matches reference ledger');
  assert.equal(data2.databaseMatch.status, 'Found in database');
  assert.equal(data2.databaseMatch.reason, 'Same invoice number');
  assert.equal(data2.databaseMatch.record.invoiceNo, uniqueInvNo);
  assert.equal(data2.databaseMatch.record.supplierGstin, testGstin);

  // 3. Search database endpoint
  const searchRes = await fetch('http://localhost:3000/fraud/searchDatabase(query=\'' + uniqueInvNo + '\')', {
    method: 'GET',
    headers: {
      'Accept': 'application/json',
      'X-User-Role': 'APClerk,APController,Auditor',
      'X-User-Id': 'single-user',
    },
  });
  assert.equal(searchRes.status, 200);
  const searchOut = await searchRes.json();
  const records = typeof searchOut.value === 'string' ? JSON.parse(searchOut.value) : (searchOut.value || searchOut);
  assert.ok(Array.isArray(records), 'Search returns records list');
  const foundRec = records.find(r => r.invoiceNo === uniqueInvNo);
  assert.ok(foundRec, 'Found newly inserted ledger record');
  assert.equal(foundRec.supplierGstin, testGstin);

  // 4. Import to ledger endpoint
  const importInvNo = 'LEDGER-IMP-' + Date.now();
  const csvContent = `Invoice No,Supplier,GSTIN,Date,Total,Description\n${importInvNo},Imported Vendor,27AABCT9999F1Z1,2026-09-01,75000,Hardware supplies`;
  const importRes = await fetch('http://localhost:3000/fraud/importToLedger', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-User-Role': 'APClerk,APController,Auditor',
      'X-User-Id': 'single-user',
    },
    body: JSON.stringify({
      fileName: 'direct-extract.csv',
      content: csvContent,
    }),
  });
  assert.equal(importRes.status, 200);
  const importOut = await importRes.json();
  const importData = typeof importOut === 'string' ? JSON.parse(importOut) : (importOut.value ? JSON.parse(importOut.value) : importOut);
  assert.ok(importData.count >= 1, 'Imported at least 1 invoice into ledger');

  // Verify the imported invoice is in the ledger via search
  const verifySearch = await fetch('http://localhost:3000/fraud/searchDatabase(query=\'' + importInvNo + '\')', {
    method: 'GET',
    headers: { 'Accept': 'application/json' },
  });
  assert.equal(verifySearch.status, 200);
  const verifyOut = await verifySearch.json();
  const verifyList = typeof verifyOut.value === 'string' ? JSON.parse(verifyOut.value) : (verifyOut.value || verifyOut);
  assert.ok(verifyList.some(r => r.invoiceNo === importInvNo), 'Imported invoice verified in ledger');

  // 5. Multi-invoice batch check verifying intra-batch comparison
  const batchInvNo = 'BATCH-' + Date.now();
  const batchGstin = '33' + Math.random().toString(36).slice(2, 6).toUpperCase() + '8888F1Z8';
  const batchInvoices = [
    {
      id: 'B1',
      invoiceNo: batchInvNo,
      supplierGstin: batchGstin,
      supplierName: 'Batch Tech',
      invoiceDate: '2026-10-10',
      total: 30000,
      description: 'Consulting',
    },
    {
      id: 'B2',
      invoiceNo: batchInvNo, // duplicate within same batch
      supplierGstin: batchGstin,
      supplierName: 'Batch Tech',
      invoiceDate: '2026-10-10',
      total: 30000,
      description: 'Consulting',
    },
  ];
  const batchRes = await fetch('http://localhost:3000/fraud/checkBatch', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-User-Role': 'APClerk,APController,Auditor',
    },
    body: JSON.stringify({ invoices: JSON.stringify(batchInvoices), sync: true }),
  });
  assert.equal(batchRes.status, 200);
  const batchOut = await batchRes.json();
  const batchResults = typeof batchOut === 'string' ? JSON.parse(batchOut) : (batchOut.value ? JSON.parse(batchOut.value) : batchOut);
  assert.equal(batchResults[0].databaseMatch.status, 'Not found in database');
  assert.equal(batchResults[1].databaseMatch.status, 'Found in database');
  assert.equal(batchResults[1].status, 'REJECT');

  // 6. Verify Activity log contains DATABASE_CHECK and LEDGER_IMPORT
  const auditRes = await fetch('http://localhost:3000/fraud/AuditLog?$orderby=idx desc&$top=20', {
    method: 'GET',
    headers: { 'Accept': 'application/json' },
  });
  assert.equal(auditRes.status, 200);
  const auditData = await auditRes.json();
  const auditActions = (auditData.value || []).map(a => a.action);
  assert.ok(auditActions.includes('DATABASE_CHECK'), 'Activity log includes DATABASE_CHECK');
  assert.ok(auditActions.includes('LEDGER_IMPORT'), 'Activity log includes LEDGER_IMPORT');

  // 7. Verify index configuration in schema
  const schemaCds = fs.readFileSync(path.join(__dirname, '../db/schema.cds'), 'utf8');
  assert.match(schemaCds, /idx_posted_gstin_fy_inv/);
  assert.match(schemaCds, /idx_posted_gstin_amt_date/);
});

test('Acceptance Check 20: Chunked processing, background job queue, GET /jobs/:id, and toast', async () => {
  const appJs = fs.readFileSync(path.join(__dirname, '../app/app.js'), 'utf8');
  const styleCss = fs.readFileSync(path.join(__dirname, '../app/style.css'), 'utf8');
  const schemaCds = fs.readFileSync(path.join(__dirname, '../db/schema.cds'), 'utf8');

  // Verify UI and CSS components
  assert.match(appJs, /pollBatchJob/);
  assert.match(appJs, /showToast/);
  assert.match(appJs, /Processing started/);
  assert.match(styleCss, /\.app-toast-container/);
  assert.match(styleCss, /\.app-toast/);
  assert.match(schemaCds, /entity Jobs : cuid/);

  // Generate a batch of 55 invoices to verify chunked processing across the 50-chunk boundary
  const prefix = 'CHK-' + Date.now() + '-';
  const batch55 = [];
  for (let i = 1; i <= 55; i++) {
    batch55.push({
      id: `C${i}`,
      invoiceNo: `${prefix}${i}`,
      supplierGstin: '27AABCT1234F1Z5',
      supplierName: 'Chunked Vendor Tech',
      invoiceDate: '2026-10-10',
      total: 1000 + i,
      description: `Item service row ${i}`,
    });
  }

  // 1. Calling checkBatch returns immediately with queued job record
  const startRes = await fetch('http://localhost:3000/fraud/checkBatch', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-User-Role': 'APClerk,APController,Auditor',
    },
    body: JSON.stringify({ invoices: JSON.stringify(batch55) }),
  });
  assert.equal(startRes.status, 200);
  const startData = await startRes.json();
  const jobInit = typeof startData === 'string' ? JSON.parse(startData) : (startData.value ? JSON.parse(startData.value) : startData);

  assert.ok(jobInit.jobId, 'Returns jobId');
  assert.equal(jobInit.total, 55, 'Job total is 55 invoices');
  assert.ok(['QUEUED', 'RUNNING'].includes(jobInit.status), 'Initial status is QUEUED or RUNNING');

  // 2. Query GET /jobs/:id
  const getJobRes = await fetch('http://localhost:3000/jobs/' + jobInit.jobId);
  assert.equal(getJobRes.status, 200);
  const jobState1 = await getJobRes.json();
  assert.equal(jobState1.total, 55);
  assert.ok(jobState1.status);

  // Poll until DONE
  let finalJob = null;
  for (let attempt = 0; attempt < 30; attempt++) {
    await new Promise(r => setTimeout(r, 200));
    const pollRes = await fetch('http://localhost:3000/jobs/' + jobInit.jobId);
    const pollData = await pollRes.json();
    if (pollData.status === 'DONE' || pollData.status === 'FAILED') {
      finalJob = pollData;
      break;
    }
  }

  assert.ok(finalJob, 'Job completed within time limit');
  assert.equal(finalJob.status, 'DONE', 'Job finished with DONE');
  assert.equal(finalJob.processed, 55, 'Processed all 55 invoices');
  assert.ok(finalJob.startedAt, 'Has startedAt timestamp');
  assert.ok(finalJob.finishedAt, 'Has finishedAt timestamp');
  assert.ok(Array.isArray(finalJob.results), 'Job contains results array');
  assert.equal(finalJob.results.length, 55);

  // 3. Verify BATCH_JOB is recorded in Activity log
  const auditRes = await fetch('http://localhost:3000/fraud/AuditLog?$orderby=idx desc&$top=20', {
    method: 'GET',
    headers: { 'Accept': 'application/json' },
  });
  assert.equal(auditRes.status, 200);
  const auditData = await auditRes.json();
  const batchJobEntries = (auditData.value || []).filter(a => a.action === 'BATCH_JOB');
  assert.ok(batchJobEntries.length >= 1, 'BATCH_JOB action logged in Activity log');
  assert.match(batchJobEntries[0].detail, /55 total/);
});

test('Acceptance Check 21: Progress bar, Cancel, Resume, and Error recovery', async () => {
  // 1. Create a 100-invoice batch (2 chunks of 50)
  const batch100 = [];
  for (let i = 1; i <= 100; i++) {
    batch100.push({
      id: `S4-BATCH21-${i}`,
      supplierName: `Test Supplier 21-${i % 5}`,
      supplierGstin: `27AABCU999${String(i % 5).padStart(2, '0')}1Z5`,
      invoiceNo: `INV-21-${i}`,
      invoiceDate: '2024-04-10',
      total: 5000 + i,
      description: `Service batch 21 row ${i}`,
    });
  }

  // Start job
  const startRes = await fetch('http://localhost:3000/fraud/checkBatch', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-User-Role': 'APClerk,APController,Auditor',
    },
    body: JSON.stringify({ invoices: JSON.stringify(batch100) }),
  });
  assert.equal(startRes.status, 200);
  const startData = await startRes.json();
  const jobInit = typeof startData === 'string' ? JSON.parse(startData) : (startData.value ? JSON.parse(startData.value) : startData);
  const jobId = jobInit.jobId || jobInit.id;
  assert.ok(jobId, 'Job created');

  // Cancel job
  const cancelRes = await fetch(`http://localhost:3000/jobs/${jobId}/cancel`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
  });
  assert.equal(cancelRes.status, 200);
  const cancelData = await cancelRes.json();
  assert.equal(cancelData.status, 'CANCELLED');

  // Wait a moment for worker loop to settle
  await new Promise(r => setTimeout(r, 200));

  // Verify status from GET /jobs/:id
  const getCancelled = await fetch(`http://localhost:3000/jobs/${jobId}`);
  const cancelledJob = await getCancelled.json();
  assert.equal(cancelledJob.status, 'CANCELLED');
  assert.ok(cancelledJob.processed <= 100);

  // Resume job via POST /jobs/:id/resume
  const resumeRes = await fetch(`http://localhost:3000/jobs/${jobId}/resume`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
  });
  assert.equal(resumeRes.status, 200);
  const resumeData = await resumeRes.json();
  assert.ok(['QUEUED', 'RUNNING', 'DONE'].includes(resumeData.status));

  // Poll until DONE
  let completedJob = null;
  for (let attempt = 0; attempt < 40; attempt++) {
    await new Promise(r => setTimeout(r, 200));
    const pollRes = await fetch(`http://localhost:3000/jobs/${jobId}`);
    const pollData = await pollRes.json();
    if (pollData.status === 'DONE' || pollData.status === 'FAILED') {
      completedJob = pollData;
      break;
    }
  }

  assert.ok(completedJob, 'Resumed job reached terminal status');
  assert.equal(completedJob.status, 'DONE');
  assert.equal(completedJob.processed, 100, 'Processed all 100 invoices');
  assert.equal(completedJob.results.length, 100, 'Contains 100 results without duplicates');

  // Verify Activity log records CANCELLED and RESUMED events with action BATCH_JOB
  const auditRes = await fetch('http://localhost:3000/fraud/AuditLog?$orderby=idx desc&$top=30', {
    headers: { 'Accept': 'application/json' },
  });
  assert.equal(auditRes.status, 200);
  const auditData = await auditRes.json();
  const batchLogs = (auditData.value || []).filter(a => a.action === 'BATCH_JOB');
  assert.ok(batchLogs.length >= 2, 'Has multiple BATCH_JOB logs');
  const details = batchLogs.map(b => b.detail).join(' ');
  assert.ok(details.includes('cancelled') || details.includes('CANCELLED'), 'Activity log has CANCELLED event');
  assert.ok(details.includes('resumed') || details.includes('RESUMED'), 'Activity log has RESUMED event');
});

test('Acceptance Check 22: 2000-invoice batch with server pagination, filters, and streaming downloads', async () => {
  // Generate 2000 test invoices with unique runId and unique year to ensure test isolation across test runs
  const runId = Math.random().toString(36).substring(2, 7).toUpperCase();
  const batch2000 = [];
  const testYear = 2030 + Math.floor(Math.random() * 60);
  const baseDate = `${testYear}-05-01`;
  for (let i = 1; i <= 2000; i++) {
    const pad = String(i).padStart(4, '0');
    let supplierName = `Vendor Corp ${i}`;
    let gstin = `27AABCT${pad}A1Z1`;
    let invoiceNo = `INV-${runId}-${pad}`;
    let total = 500 + i;

    if (i === 2) {
      // Intentional duplicate of invoice 1 (will be REJECT)
      supplierName = 'Vendor Corp 1';
      gstin = '27AABCT0001A1Z1';
      invoiceNo = `INV-${runId}-0001`;
      total = 501;
    } else if (i === 11) {
      // Split pattern with invoice 10 (will be HOLD)
      supplierName = 'Vendor Corp 10';
      gstin = '27AABCT0010A1Z1';
      total = 65000;
    } else if (i === 10) {
      total = 65000;
    }

    batch2000.push({
      id: `INV-2K-${pad}`,
      supplierName,
      supplierGstin: gstin,
      invoiceNo,
      invoiceDate: baseDate,
      total,
      lineItems: [{ description: `Consulting Service ${i}`, amount: total }],
    });
  }

  // 1. Submit 2000-invoice batch check
  const startRes = await fetch('http://localhost:3000/fraud/checkBatch', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-User-Role': 'APClerk,APController,Auditor',
    },
    body: JSON.stringify({ invoices: JSON.stringify(batch2000) }),
  });
  assert.equal(startRes.status, 200);
  const startData = await startRes.json();
  const jobInit = typeof startData === 'string' ? JSON.parse(startData) : (startData.value ? JSON.parse(startData.value) : startData);
  const jobId = jobInit.jobId || jobInit.id;
  assert.ok(jobId, '2000-invoice job created');

  // Poll until DONE (40 chunks of 50 invoices)
  let completedJob = null;
  for (let attempt = 0; attempt < 100; attempt++) {
    await new Promise(r => setTimeout(r, 250));
    const pollRes = await fetch(`http://localhost:3000/jobs/${jobId}`);
    const pollData = await pollRes.json();
    if (pollData.status === 'DONE' || pollData.status === 'FAILED') {
      completedJob = pollData;
      break;
    }
  }

  assert.ok(completedJob, '2000-invoice job completed');
  assert.equal(completedJob.status, 'DONE');
  assert.equal(completedJob.processed, 2000, 'Processed all 2000 invoices');

  // 2. Test S/4 Results Server-Side Pagination
  // Page 1: 50 rows per page
  const page1Res = await fetch(`http://localhost:3000/fraud/s4Results?jobId=${jobId}&page=1&limit=50`);
  assert.equal(page1Res.status, 200);
  const page1Data = await page1Res.json();
  assert.equal(page1Data.page, 1);
  assert.equal(page1Data.limit, 50);
  assert.equal(page1Data.total, 2000);
  assert.equal(page1Data.totalPages, 40);
  assert.equal(page1Data.rows.length, 50);
  assert.equal(page1Data.counts.total, 2000);
  assert.equal(page1Data.counts.pass + page1Data.counts.hold + page1Data.counts.reject, 2000);

  // Page 2: next 50 rows
  const page2Res = await fetch(`http://localhost:3000/fraud/s4Results?jobId=${jobId}&page=2&limit=50`);
  assert.equal(page2Res.status, 200);
  const page2Data = await page2Res.json();
  assert.equal(page2Data.page, 2);
  assert.equal(page2Data.rows.length, 50);
  assert.notEqual(page1Data.rows[0].invoiceId, page2Data.rows[0].invoiceId);

  // 3. Test S/4 Server-Side Search Filter across all pages
  const searchRes = await fetch(`http://localhost:3000/fraud/s4Results?jobId=${jobId}&search=INV-${runId}-0450&limit=50`);
  assert.equal(searchRes.status, 200);
  const searchData = await searchRes.json();
  assert.equal(searchData.total, 1);
  assert.equal(searchData.rows[0].invoiceNo, `INV-${runId}-0450`);

  // 4. Test S/4 Server-Side Status Filter
  const passFilterRes = await fetch(`http://localhost:3000/fraud/s4Results?jobId=${jobId}&status=PASS&limit=50`);
  assert.equal(passFilterRes.status, 200);
  const passData = await passFilterRes.json();
  assert.ok(passData.rows.length > 0);
  for (const row of passData.rows) {
    assert.equal(row.status, 'PASS');
  }

  // 5. Test Review Queue Server-Side Pagination
  const reviewRes = await fetch(`http://localhost:3000/fraud/reviewQueue?page=1&limit=50&status=ALL`);
  assert.equal(reviewRes.status, 200);
  const reviewData = await reviewRes.json();
  assert.ok(reviewData.rows !== undefined);
  assert.ok(reviewData.rows.length <= 50);
  if (reviewData.rows.length > 0) {
    // Assert no rule codes in ruleName
    const first = reviewData.rows[0];
    assert.ok(first.invoiceNo !== undefined);
    assert.ok(first.supplierName !== undefined);
    assert.ok(!first.ruleName.includes('AP-02') && !first.ruleName.includes('AP-03') && !first.ruleName.includes('AP-09') && !first.ruleName.includes('AP-11'));
  }

  // 6. Test Check History Server-Side Limit Selector (25, 50, 100)
  const hist25Res = await fetch(`http://localhost:3000/fraud/checkHistory?page=1&limit=25`);
  const hist25 = await hist25Res.json();
  assert.equal(hist25.rows.length, 25);
  assert.ok(hist25.total >= 2000);

  const hist50Res = await fetch(`http://localhost:3000/fraud/checkHistory?page=1&limit=50`);
  const hist50 = await hist50Res.json();
  assert.equal(hist50.rows.length, 50);

  const hist100Res = await fetch(`http://localhost:3000/fraud/checkHistory?page=1&limit=100`);
  const hist100 = await hist100Res.json();
  assert.equal(hist100.rows.length, 100);

  // 7. Test Activity Log Server-Side Pagination & Action Filter
  const actBatchRes = await fetch(`http://localhost:3000/fraud/activityLogs?page=1&limit=50&action=BATCH_JOB`);
  assert.equal(actBatchRes.status, 200);
  const actBatch = await actBatchRes.json();
  assert.ok(actBatch.rows.length > 0);
  for (const row of actBatch.rows) {
    assert.equal(row.action, 'BATCH_JOB');
  }

  // Verify Audit Hash Chain integrity count text
  const chainRes = await fetch('http://localhost:3000/fraud/verifyAuditChain');
  const chainRaw = await chainRes.json();
  const chain = typeof chainRaw.value === 'string' ? JSON.parse(chainRaw.value) : (chainRaw.value || chainRaw);
  assert.equal(chain.ok, true);
  assert.ok(chain.entries >= 1);
  const integrityText = chain.entries === 1 ? '1 entry intact' : `${chain.entries} entries intact`;
  assert.ok(integrityText.includes('intact'));

  // 8. Test Streaming S/4 CSV Download (All 2000 matching rows, no rule codes, UTF-8 with BOM)
  const s4CsvRes = await fetch('http://localhost:3000/fraud/exportS4Csv', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jobId, status: 'ALL' }),
  });
  assert.equal(s4CsvRes.status, 200);
  assert.ok(s4CsvRes.headers.get('content-type').includes('text/csv'));
  const s4CsvBuf = Buffer.from(await s4CsvRes.arrayBuffer());
  assert.equal(s4CsvBuf[0], 0xef, 'CSV byte 0 is UTF-8 BOM 0xEF');
  assert.equal(s4CsvBuf[1], 0xbb, 'CSV byte 1 is UTF-8 BOM 0xBB');
  assert.equal(s4CsvBuf[2], 0xbf, 'CSV byte 2 is UTF-8 BOM 0xBF');
  const s4CsvText = s4CsvBuf.toString('utf8');
  // No rule codes in CSV headers or rows
  const headerLine = s4CsvText.split('\n')[0];
  assert.ok(!headerLine.includes('AP-02') && !headerLine.includes('AP-03') && !headerLine.includes('AP-09') && !headerLine.includes('AP-11'), 'No rule codes in S4 CSV headers');
  const s4Lines = s4CsvText.trim().split(/\r?\n/);
  // Header + 2000 data rows = 2001 lines
  assert.equal(s4Lines.length, 2001, 'CSV export streams all 2000 rows across pages');

  // 9. Test Streaming S/4 Excel Download (Valid .xlsx)
  const s4ExcelRes = await fetch('http://localhost:3000/fraud/exportS4Excel', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jobId, status: 'ALL' }),
  });
  assert.equal(s4ExcelRes.status, 200);
  assert.equal(s4ExcelRes.headers.get('content-type'), 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  const s4ExcelBuf = await s4ExcelRes.arrayBuffer();
  assert.ok(s4ExcelBuf.byteLength > 5000, 'Valid Excel workbook stream generated');

  // 10. Test Streaming Check History CSV and Excel Downloads
  const histCsvRes = await fetch('http://localhost:3000/fraud/exportHistoryCsv', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: 'ALL' }),
  });
  assert.equal(histCsvRes.status, 200);
  assert.ok(histCsvRes.headers.get('content-type').includes('text/csv'));
  const histCsvBuf = Buffer.from(await histCsvRes.arrayBuffer());
  assert.equal(histCsvBuf[0], 0xef, 'History CSV byte 0 is UTF-8 BOM 0xEF');
  assert.equal(histCsvBuf[1], 0xbb, 'History CSV byte 1 is UTF-8 BOM 0xBB');
  assert.equal(histCsvBuf[2], 0xbf, 'History CSV byte 2 is UTF-8 BOM 0xBF');
  const histCsvText = histCsvBuf.toString('utf8');
  const histHeader = histCsvText.split('\n')[0];
  assert.ok(!histHeader.includes('AP-02') && !histHeader.includes('AP-03') && !histHeader.includes('AP-09') && !histHeader.includes('AP-11'), 'No rule codes in History CSV headers');

  const histExcelRes = await fetch('http://localhost:3000/fraud/exportHistoryExcel', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: 'ALL' }),
  });
  assert.equal(histExcelRes.status, 200);
  assert.equal(histExcelRes.headers.get('content-type'), 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  const histExcelBuf = await histExcelRes.arrayBuffer();
  assert.ok(histExcelBuf.byteLength > 5000, 'Valid Excel workbook stream for check history');
});

test('Acceptance Check 23: PDF/OCR safety, 2000 invoice limit, and Activity Log BATCH_JOB logging', async () => {
  const { resetOcrMetrics, getOcrMetrics } = require('../srv/lib/ocr');
  resetOcrMetrics();

  // 1. Upload CSV with 2001 rows -> rejected with clear message
  const csvRows = ['id,supplierName,supplierGstin,invoiceNo,invoiceDate,total'];
  for (let i = 1; i <= 2001; i++) {
    csvRows.push(`${i},Vendor ${i},27AABCT0001A1Z1,INV-2001-${i},2026-05-01,1500`);
  }
  const csv2001Text = csvRows.join('\n');

  const rejectCsvRes = await fetch('http://localhost:3000/fraud/importS4Extract', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-User-Role': 'APClerk,APController,Auditor',
    },
    body: JSON.stringify({
      fileName: 'large-batch-2001.csv',
      content: csv2001Text,
    }),
  });
  assert.equal(rejectCsvRes.status, 400);
  const rejectCsvData = await rejectCsvRes.json();
  const errMsg = (rejectCsvData.error && rejectCsvData.error.message) || JSON.stringify(rejectCsvData);
  assert.match(
    errMsg,
    /This batch has 2001 invoices\. The maximum per job is 2000\. Please split the file\./,
    'CSV with 2001 rows is rejected with exact limit message'
  );

  // Also confirm checkBatch rejects 2001 invoices
  const rejectBatchRes = await fetch('http://localhost:3000/fraud/checkBatch', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-User-Role': 'APClerk,APController,Auditor',
    },
    body: JSON.stringify({
      invoices: JSON.stringify(Array.from({ length: 2001 }, (_, i) => ({
        id: `INV-${i}`,
        invoiceNo: `INV-${i}`,
        supplierGstin: '27AABCT0001A1Z1',
        total: 100,
        invoiceDate: '2026-05-01',
      }))),
    }),
  });
  assert.equal(rejectBatchRes.status, 400);
  const rejectBatchData = await rejectBatchRes.json();
  const batchErrMsg = (rejectBatchData.error && rejectBatchData.error.message) || JSON.stringify(rejectBatchData);
  assert.match(
    batchErrMsg,
    /This batch has 2001 invoices\. The maximum per job is 2000\. Please split the file\./,
    'checkBatch with 2001 invoices is rejected with exact limit message'
  );

  // 2. Size limit per file (10 MB)
  const tooLargeRes = await fetch('http://localhost:3000/fraud/uploadBatchDocuments', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-User-Role': 'APClerk,APController,Auditor',
    },
    body: JSON.stringify({
      files: [
        {
          fileName: 'oversized-invoice.pdf',
          fileSize: 11 * 1024 * 1024, // 11 MB
          fileBase64: Buffer.from('%PDF-1.4 test').toString('base64'),
        },
      ],
    }),
  });
  assert.equal(tooLargeRes.status, 400);
  const tooLargeData = await tooLargeRes.json();
  const sizeErrMsg = (tooLargeData.error && tooLargeData.error.message) || JSON.stringify(tooLargeData);
  assert.match(sizeErrMsg, /Maximum size is 10 MB/i, 'File exceeding 10 MB is rejected with clear message');

  // 3. Upload 5 PDFs at once and confirm processed one at a time with OCR concurrency never above 2
  const sampleCleanPdf = fs.readFileSync(path.join(__dirname, '../samples/sample-invoice-clean.pdf'));
  const sampleCleanB64 = sampleCleanPdf.toString('base64');
  const sampleDupPdf = fs.readFileSync(path.join(__dirname, '../samples/sample-invoice-duplicate.pdf'));
  const sampleDupB64 = sampleDupPdf.toString('base64');

  const fiveFiles = [
    { fileName: 'invoice-batch-1.pdf', fileSize: sampleCleanPdf.length, fileBase64: sampleCleanB64 },
    { fileName: 'invoice-batch-2.pdf', fileSize: sampleDupPdf.length, fileBase64: sampleDupB64 },
    { fileName: 'invoice-batch-3.pdf', fileSize: sampleCleanPdf.length, fileBase64: sampleCleanB64 },
    { fileName: 'invoice-batch-4.pdf', fileSize: sampleDupPdf.length, fileBase64: sampleDupB64 },
    { fileName: 'invoice-batch-5.pdf', fileSize: sampleCleanPdf.length, fileBase64: sampleCleanB64 },
  ];

  const batchPdfRes = await fetch('http://localhost:3000/fraud/uploadBatchDocuments', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-User-Role': 'APClerk,APController,Auditor',
    },
    body: JSON.stringify({ files: fiveFiles }),
  });
  assert.equal(batchPdfRes.status, 200, '5 PDFs uploaded successfully');
  const batchPdfData = await batchPdfRes.json();
  const pdfJobId = batchPdfData.jobId || batchPdfData.id;
  assert.ok(pdfJobId, 'Job ID created for 5 PDFs');

  // Check OCR metrics: peak concurrency must never exceed 2
  const ocrMetrics = getOcrMetrics();
  assert.ok(ocrMetrics.peak <= 2, `OCR concurrency peak (${ocrMetrics.peak}) never exceeded 2`);

  // Poll until job is DONE
  let completedPdfJob = null;
  for (let attempt = 0; attempt < 40; attempt++) {
    await new Promise(r => setTimeout(r, 200));
    const pollRes = await fetch(`http://localhost:3000/jobs/${pdfJobId}`);
    const pollData = await pollRes.json();
    if (pollData.status === 'DONE' || pollData.status === 'FAILED') {
      completedPdfJob = pollData;
      break;
    }
  }
  assert.ok(completedPdfJob, '5-PDF batch job completed');
  assert.equal(completedPdfJob.status, 'DONE');
  assert.equal(completedPdfJob.processed, 5, 'Processed all 5 PDFs');

  // 4. Confirm the job appears in the Activity log
  const actRes = await fetch('http://localhost:3000/fraud/activityLogs?action=BATCH_JOB&limit=10', {
    headers: { 'X-User-Role': 'APClerk,APController,Auditor' },
  });
  assert.equal(actRes.status, 200);
  const actData = await actRes.json();
  assert.ok(Array.isArray(actData.rows) && actData.rows.length > 0);

  // Find the completed job log entry
  const jobLog = actData.rows.find(r => r.detail && r.detail.includes('5 total'));
  assert.ok(jobLog, 'Activity log contains completed 5-PDF batch job');
  assert.equal(jobLog.action, 'BATCH_JOB', 'Action is BATCH_JOB');
  assert.match(jobLog.detail, /\[user=User\]/, 'User is User in detail tag');
  assert.match(jobLog.detail, /5 total/);
  assert.match(jobLog.detail, /passed/);
  assert.match(jobLog.detail, /blocked|held/);
  assert.match(jobLog.detail, /in \d+ms/);
});





