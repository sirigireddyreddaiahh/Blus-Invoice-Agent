'use strict';
const { test } = require('node:test');
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
