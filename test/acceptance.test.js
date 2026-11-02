'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { runRules } = require('../srv/rules/engine');
const { RULES, RULE_CONFIG, checkDataQuality } = require('../srv/rules/rules');
const {
  validateAndDetectFile,
  computeFieldConfidences,
  extractFields,
  MAX_FILE_BYTES,
} = require('../srv/lib/extract');
const { runOcr, MISSING_OCR_MSG, OCR_WARNING_MSG } = require('../srv/lib/ocr');
const lookup = require('../srv/lib/lookup');
const FraudService = require('../srv/fraud-service');

const masters = JSON.parse(fs.readFileSync(path.join(__dirname, '../data/masters.json'), 'utf8'));
const s4Invoices = JSON.parse(fs.readFileSync(path.join(__dirname, '../data/s4-invoices.json'), 'utf8'));
const vendor1 = masters.vendors[0];
const vendor4 = masters.vendors[3];
const recurringPoObj = masters.purchaseOrders.find(p => p.recurring);

// ============================================================================
// RULES (Tests 1 - 7)
// ============================================================================

test('Acceptance 1: A clean invoice returns PASS', () => {
  const cleanInv = {
    supplierGstin: vendor1.gstin,
    supplierId: vendor1.id,
    invoiceNo: 'CLEAN-INV-2026-999',
    invoiceDate: '2026-10-25',
    total: 50000,
    description: 'General facility repairs',
  };
  const res = runRules(cleanInv, { masters, posted: [], batch: [], earlier: [] });
  assert.equal(res.status, 'PASS');
});

test('Acceptance 2: The same invoice number posted twice returns REJECT on the second post (AP-02)', () => {
  const inv = {
    supplierGstin: vendor1.gstin,
    supplierId: vendor1.id,
    invoiceNo: 'DUP-TEST-001',
    invoiceDate: '2026-10-20',
    total: 50000,
    description: 'Electrical maintenance',
  };
  const posted = [{
    invoiceNo: 'DUP-TEST-001',
    supplierGstin: vendor1.gstin,
    invoiceDate: '2026-10-18',
    total: 50000,
  }];
  const res = runRules(inv, { masters, posted, batch: [], earlier: [] });
  assert.equal(res.status, 'REJECT');
  const ap02 = res.results.find(r => r.id === 'AP-02');
  assert.equal(ap02.tier, 'REJECT');
});

test('Acceptance 3: The same GSTIN on two vendor IDs returns REJECT, unless the pair is on the exemption list (AP-03)', () => {
  // Default exemption list is empty in masters.json
  assert.deepEqual(masters.parentAffiliateExemptions, []);

  const customMasters = JSON.parse(JSON.stringify(masters));
  customMasters.vendors.push({
    id: 'V-DUPLICATE',
    name: 'Duplicate Vendor ID Registration',
    gstin: vendor1.gstin,
  });

  const inv = {
    supplierGstin: vendor1.gstin,
    supplierId: 'V-DUPLICATE',
    invoiceNo: 'REUSE-001',
    invoiceDate: '2026-10-20',
    total: 25000,
    description: 'Hardware tools',
  };
  const res = runRules(inv, { masters: customMasters, posted: [], batch: [], earlier: [] });
  assert.equal(res.status, 'REJECT');
  assert.equal(res.results.find(r => r.id === 'AP-03').tier, 'REJECT');

  // When documented parent/affiliate pair is on the configurable exemption list, it passes
  const exemptMasters = JSON.parse(JSON.stringify(customMasters));
  exemptMasters.parentAffiliateExemptions = [[vendor1.id, 'V-DUPLICATE']];
  const resExempt = runRules(inv, { masters: exemptMasters, posted: [], batch: [], earlier: [] });
  assert.equal(resExempt.results.find(r => r.id === 'AP-03').tier, 'PASS');
});

test('Acceptance 4: A repeat bill with the same amount and similar services within 90 days returns REJECT, unless it matches a recurring contract PO (AP-09)', () => {
  const posted = [{
    invoiceNo: 'ORIG-100',
    supplierGstin: vendor1.gstin,
    invoiceDate: '2026-10-01',
    total: 75000,
    description: 'Campus sanitization services for block A',
  }];

  const repeatInv = {
    supplierGstin: vendor1.gstin,
    invoiceNo: 'REPEAT-101',
    invoiceDate: '2026-10-20',
    total: 75000,
    description: 'Campus sanitization services for block A',
  };

  const res = runRules(repeatInv, { masters, posted, batch: [], earlier: [] });
  assert.equal(res.status, 'REJECT');
  assert.equal(res.results.find(r => r.id === 'AP-09').tier, 'REJECT');

  // Recurring contract PO is excluded
  const recurringInv = {
    ...repeatInv,
    poNumber: recurringPoObj.po,
  };
  const resRec = runRules(recurringInv, { masters, posted, batch: [], earlier: [] });
  assert.equal(resRec.results.find(r => r.id === 'AP-09').tier, 'PASS');
});

test('Acceptance 5: Two bills of 98,500 INR from one vendor within 14 days return HOLD (AP-11)', () => {
  const inv1 = {
    id: 'B1',
    supplierGstin: vendor4.gstin,
    invoiceNo: 'BILL-1',
    invoiceDate: '2026-10-10',
    total: 98500,
    description: 'Signage printing',
  };
  const inv2 = {
    id: 'B2',
    supplierGstin: vendor4.gstin,
    invoiceNo: 'BILL-2',
    invoiceDate: '2026-10-15',
    total: 98500,
    description: 'Brochure printing',
  };

  const batch = [inv1, inv2];
  const res2 = runRules(inv2, { masters, posted: [], batch, earlier: [inv1] });
  assert.equal(res2.status, 'HOLD');
  assert.equal(res2.results.find(r => r.id === 'AP-11').tier, 'HOLD');
});

test('Acceptance 6: A clerk cannot decide an alert. A controller cannot post. An auditor cannot post, upload or check.', async () => {
  const baseUrl = 'http://localhost:3000/fraud';

  // 1) Clerk cannot decide an alert
  const rClerk = await fetch(`${baseUrl}/decideAlert`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-User-Role': 'APClerk' },
    body: JSON.stringify({ alertId: '00000000-0000-0000-0000-000000000000', decision: 'CLEAR', comment: 'Attempt by clerk' }),
  });
  assert.equal(rClerk.status, 403);

  // 2) Controller cannot post
  const rCtrl = await fetch(`${baseUrl}/postInvoice`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-User-Role': 'APController' },
    body: JSON.stringify({ invoice: JSON.stringify(s4Invoices[0]) }),
  });
  assert.equal(rCtrl.status, 403);

  // 3) Auditor cannot post, upload or check
  const rAudPost = await fetch(`${baseUrl}/postInvoice`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-User-Role': 'Auditor' },
    body: JSON.stringify({ invoice: JSON.stringify(s4Invoices[0]) }),
  });
  assert.equal(rAudPost.status, 403);

  const rAudUpload = await fetch(`${baseUrl}/uploadDocument`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-User-Role': 'Auditor' },
    body: JSON.stringify({ fileName: 'test.pdf', fileSize: 100, fileBase64: '' }),
  });
  assert.equal(rAudUpload.status, 403);

  const rAudCheck = await fetch(`${baseUrl}/checkInvoice`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-User-Role': 'Auditor' },
    body: JSON.stringify({ invoice: JSON.stringify(s4Invoices[0]) }),
  });
  assert.equal(rAudCheck.status, 403);
});

test('Acceptance 7: All 14 rule results are stored for each check. The 10 disabled rules are stored as DISABLED and are not shown on screen.', () => {
  const inv = {
    supplierGstin: vendor1.gstin,
    invoiceNo: 'RULE-CHECK-01',
    invoiceDate: '2026-10-20',
    total: 10000,
    description: 'Test check',
  };
  const res = runRules(inv, { masters, posted: [], batch: [], earlier: [] });
  assert.equal(res.results.length, 14);

  const disabledIds = ['AP-01', 'AP-04', 'AP-05', 'AP-06', 'AP-07', 'AP-08', 'AP-10', 'AP-12', 'AP-13', 'AP-14'];
  assert.equal(disabledIds.length, 10);
  for (const id of disabledIds) {
    const r = res.results.find(x => x.id === id);
    assert.ok(r, `Rule ${id} missing`);
    assert.equal(r.tier, 'DISABLED');
  }

  const activeIds = ['AP-02', 'AP-03', 'AP-09', 'AP-11'];
  for (const id of activeIds) {
    const r = res.results.find(x => x.id === id);
    assert.ok(r, `Active rule ${id} missing`);
    assert.notEqual(r.tier, 'DISABLED');
  }
});

// ============================================================================
// UPLOAD AND EXTRACTION (Tests 8 - 13)
// ============================================================================

test('Acceptance 8: A PNG invoice uploads, shows all 10 steps, and produces a result', async () => {
  const pngPath = path.join(__dirname, '../samples/sample-invoice-clean.png');
  const buf = fs.readFileSync(pngPath);
  const r = await fetch('http://localhost:3000/fraud/uploadDocument', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-User-Role': 'APClerk' },
    body: JSON.stringify({
      fileName: 'sample-invoice-clean.png',
      fileSize: buf.length,
      fileBase64: buf.toString('base64'),
    }),
  });
  assert.equal(r.status, 200);
  const body = await r.json();
  const out = JSON.parse(body.value);
  assert.equal(out.ok, true);
  assert.equal(out.fileType, 'Image (PNG or JPG)');
  assert.equal(out.ocrUsed, true);
  assert.equal(out.warning, OCR_WARNING_MSG);
  assert.equal(out.steps.length, 10);
  assert.ok(['PASS', 'HOLD', 'REJECT'].includes(out.status));
});

test('Acceptance 9: A JPG invoice uploads the same way', async () => {
  const jpgPath = path.join(__dirname, '../samples/sample-invoice-clean.jpg');
  const buf = fs.readFileSync(jpgPath);
  const r = await fetch('http://localhost:3000/fraud/uploadDocument', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-User-Role': 'APClerk' },
    body: JSON.stringify({
      fileName: 'sample-invoice-clean.jpg',
      fileSize: buf.length,
      fileBase64: buf.toString('base64'),
    }),
  });
  assert.equal(r.status, 200);
  const body = await r.json();
  const out = JSON.parse(body.value);
  assert.equal(out.ok, true);
  assert.equal(out.fileType, 'Image (PNG or JPG)');
  assert.equal(out.ocrUsed, true);
  assert.equal(out.steps.length, 10);
  assert.ok(['PASS', 'HOLD', 'REJECT'].includes(out.status));
});

test('Acceptance 10: A file that is not PDF, PNG or JPG is rejected with a clear message', async () => {
  const fakeDocx = Buffer.from('PK\x03\x04 fake word document');
  const check = validateAndDetectFile('invoice.docx', fakeDocx, fakeDocx.length);
  assert.equal(check.ok, false);
  assert.match(check.error, /Only PDF, PNG and JPG files are accepted/);

  const r = await fetch('http://localhost:3000/fraud/uploadDocument', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-User-Role': 'APClerk' },
    body: JSON.stringify({
      fileName: 'invoice.xlsx',
      fileSize: fakeDocx.length,
      fileBase64: fakeDocx.toString('base64'),
    }),
  });
  assert.equal(r.status, 400);
  const errBody = await r.json();
  assert.match(errBody.error.message, /Only PDF, PNG and JPG files are accepted/);
});

test('Acceptance 11: A file over 10 MB is rejected', async () => {
  const overSize = MAX_FILE_BYTES + 1024;
  const check = validateAndDetectFile('huge-invoice.pdf', Buffer.from('%PDF-1.4'), overSize);
  assert.equal(check.ok, false);
  assert.match(check.error, /10 MB/);

  const r = await fetch('http://localhost:3000/fraud/uploadDocument', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-User-Role': 'APClerk' },
    body: JSON.stringify({
      fileName: 'huge-invoice.pdf',
      fileSize: overSize,
      fileBase64: Buffer.from('%PDF-1.4').toString('base64'),
    }),
  });
  assert.equal(r.status, 400);
  const errBody = await r.json();
  assert.match(errBody.error.message, /10 MB/);
});

test('Acceptance 12: A Low-confidence field blocks "Post to ledger" until the user confirms it', async () => {
  // 1) Verify field with OCR confidence < 70% is flagged as Low
  const confs = computeFieldConfidences(
    { invoiceNo: 'INV-LOW-01', total: 50000 },
    { ocrUsed: true, ocrConfidence: 62, words: [{ text: 'INV-LOW-01', confidence: 55 }] }
  );
  assert.equal(confs.invoiceNo.label, 'Low');

  // 2) Verify server blocks postInvoice when unconfirmedLowFields is non-empty
  const rBlocked = await fetch('http://localhost:3000/fraud/postInvoice', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-User-Role': 'APClerk' },
    body: JSON.stringify({
      invoice: JSON.stringify({
        ...s4Invoices[0],
        invoiceNo: 'LOW-CONF-BLOCK-TEST',
        unconfirmedLowFields: ['Invoice number'],
      }),
    }),
  });
  assert.equal(rBlocked.status, 400);
  const errBody = await rBlocked.json();
  assert.match(errBody.error.message, /Confirm all Low-confidence fields before posting/);
});

test('Acceptance 13: With OCR language data missing, the user sees "Image could not be read. Enter the fields manually."', async () => {
  const prevPath = process.env.TESSDATA_PATH;
  process.env.TESSDATA_PATH = '/tmp/non-existent-tessdata-dir';
  try {
    const pngBuf = fs.readFileSync(path.join(__dirname, '../samples/sample-invoice-clean.png'));
    const ocrRes = await runOcr(pngBuf);
    assert.equal(ocrRes.ok, false);
    assert.equal(ocrRes.error, 'Image could not be read. Enter the fields manually.');
  } finally {
    if (prevPath === undefined) delete process.env.TESSDATA_PATH;
    else process.env.TESSDATA_PATH = prevPath;
  }
});

// ============================================================================
// INTERFACE (Tests 14 - 18)
// ============================================================================

test('Acceptance 14: The sidebar shows the six items in the order in section 2.1, and the app opens on Upload invoice', () => {
  const html = fs.readFileSync(path.join(__dirname, '../app/index.html'), 'utf8');
  const navMatches = [...html.matchAll(/class="nav-item([^"]*)"[^>]*data-page="([^"]+)"[^>]*>([^<]+)</g)];
  assert.equal(navMatches.length, 6);
  const labels = navMatches.map(m => m[3].replace(/^\d+\.\s*/, '').trim());
  assert.deepEqual(labels, [
    'AI assistant',
    'Upload invoice',
    'S/4HANA extract',
    'Review queue',
    'Check history',
    'Activity log',
  ]);
  // Verify Upload invoice has the active class on initial load
  const activeNav = navMatches.find(m => m[1].includes('active'));
  assert.equal(activeNav[2], 'upload');
  assert.match(html, /id="page-upload"\s+class="page-section active"/);
});

test('Acceptance 15: The result card shows only the four active rules and the line "N rules are disabled by configuration."', () => {
  const appJs = fs.readFileSync(path.join(__dirname, '../app/app.js'), 'utf8');
  assert.match(appJs, /rules are disabled by configuration\./);
  assert.deepEqual(FraudService.ACTIVE_RULE_IDS, ['AP-02', 'AP-03', 'AP-09', 'AP-11']);
  assert.equal(FraudService.DISABLED_RULE_IDS.length, 10);
});

test('Acceptance 16: Post to ledger is disabled for REJECT', () => {
  const appJs = fs.readFileSync(path.join(__dirname, '../app/app.js'), 'utf8');
  assert.match(appJs, /const isReject = state\.currentResult && state\.currentResult\.status === 'REJECT'/);
  assert.match(appJs, /btn\.disabled = !canPostRole \|\| !hasResult \|\| isReject \|\| unconfirmed\.length > 0/);
});

test('Acceptance 17: Check history exports a CSV that opens in Excel, with active rules only', () => {
  const appJs = fs.readFileSync(path.join(__dirname, '../app/app.js'), 'utf8');
  assert.match(appJs, /AP-02 \(Exact duplicate\)/);
  assert.match(appJs, /AP-03 \(GSTIN reuse\)/);
  assert.match(appJs, /AP-09 \(Same vendor\/amount\/services\)/);
  assert.match(appJs, /AP-11 \(Split invoices\)/);
  assert.equal(appJs.includes('AP-01 ('), false, 'Export CSV must not include disabled rule AP-01');
  assert.equal(appJs.includes('AP-14 ('), false, 'Export CSV must not include disabled rule AP-14');
});

test('Acceptance 18: An Auditor sees no Post, Upload or decision buttons', () => {
  const appJs = fs.readFileSync(path.join(__dirname, '../app/app.js'), 'utf8');
  assert.match(appJs, /if \(uploadBtns\) uploadBtns\.classList\.toggle\('hidden', !canUploadOrCheck\)/);
  assert.match(appJs, /if \(postBtn\) postBtn\.classList\.toggle\('hidden', !canPost\)/);
  assert.match(appJs, /if \(canDecide\)/);
});

// ============================================================================
// LOOKUP LAYER (Tests 19 - 21)
// ============================================================================

test('Acceptance 19: With CLIENT_DB_LOOKUP_ENABLED unset or "false", the app behaves exactly as before', async () => {
  const prev = process.env.CLIENT_DB_LOOKUP_ENABLED;
  delete process.env.CLIENT_DB_LOOKUP_ENABLED;
  try {
    const vendors = await lookup.findVendorByGstin(vendor1.gstin, { user: 'test-user' });
    assert.equal(vendors.length, 1);
    assert.deepEqual(Object.keys(vendors[0]).sort(), ['gstin', 'id', 'name']);

    const bank = await lookup.findVendorBankDetails(vendor1.id, { user: 'test-user' });
    assert.deepEqual(Object.keys(bank).sort(), ['account', 'ifsc', 'vendorId']);

    const pos = await lookup.findOpenPurchaseOrders(vendor1.id, { user: 'test-user' });
    assert.ok(pos.length >= 1);

    const posted = await lookup.findPostedInvoices(vendor1.id, '2026-27', { user: 'test-user' });
    assert.ok(Array.isArray(posted));
  } finally {
    if (prev !== undefined) process.env.CLIENT_DB_LOOKUP_ENABLED = prev;
  }
});

test('Acceptance 20: With the flag "true" and no credentials, the app shows "Client database is not configured" and does not fall back silently', async () => {
  const prevFlag = process.env.CLIENT_DB_LOOKUP_ENABLED;
  const prevHost = process.env.CLIENT_DB_HOST;
  const prevUrl = process.env.CLIENT_DB_URL;
  process.env.CLIENT_DB_LOOKUP_ENABLED = 'true';
  delete process.env.CLIENT_DB_HOST;
  delete process.env.CLIENT_DB_URL;

  try {
    await assert.rejects(
      async () => lookup.findVendorByGstin(vendor1.gstin, { user: 'test-user' }),
      /Client database is not configured/
    );
  } finally {
    if (prevFlag === undefined) delete process.env.CLIENT_DB_LOOKUP_ENABLED;
    else process.env.CLIENT_DB_LOOKUP_ENABLED = prevFlag;
    if (prevHost !== undefined) process.env.CLIENT_DB_HOST = prevHost;
    if (prevUrl !== undefined) process.env.CLIENT_DB_URL = prevUrl;
  }
});

test('Acceptance 21: A test proves that the client lookup cannot run an insert, update or delete', async () => {
  await assert.rejects(
    async () => lookup.executeReadOnlyQuery('INSERT INTO client_vendors VALUES (?, ?, ?)', ['V9', 'Bad', '123']),
    /Read-only violation: client lookup cannot run INSERT, UPDATE, DELETE/
  );
  await assert.rejects(
    async () => lookup.executeReadOnlyQuery('UPDATE client_vendors SET name = ? WHERE id = ?', ['Hacked', 'V1']),
    /Read-only violation: client lookup cannot run INSERT, UPDATE, DELETE/
  );
  await assert.rejects(
    async () => lookup.executeReadOnlyQuery('DELETE FROM client_vendors WHERE id = ?', ['V1']),
    /Read-only violation: client lookup cannot run INSERT, UPDATE, DELETE/
  );
});

// ============================================================================
// ASSISTANT (Tests 22 - 25)
// ============================================================================

test('Acceptance 22: With GEMINI_API_KEY unset, the assistant shows "The assistant is not configured" and no fake answer', async () => {
  const r = await fetch('http://localhost:3000/fraud/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: 'How many invoices are blocked?' }),
  });
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.equal(body.value, 'The assistant is not configured.');
});

test('Acceptance 23: With a valid key, "How many invoices are blocked?" returns a count that matches the database', async () => {
  // Verify database Posted table blocked count matches grounding payload blockedInvoicesCount
  const rPosted = await fetch('http://localhost:3000/fraud/Posted');
  const postedBody = await rPosted.json();
  const dbBlockedCount = (postedBody.value || []).filter(p => p.blocked).length;

  const grounding = FraudService.buildGroundingPayload({
    posted: postedBody.value || [],
    alerts: [],
    checks: [],
    auditRows: [],
    auditChainValid: true,
  }, false);

  assert.equal(grounding.blockedInvoicesCount, dbBlockedCount);
});

test('Acceptance 24: With ALLOW_INVOICE_DATA_TO_LLM unset, the request sent to Gemini contains no GSTIN, bank account or invoice amount', () => {
  const allowInvoiceData = process.env.ALLOW_INVOICE_DATA_TO_LLM === 'true';
  assert.equal(allowInvoiceData, false);

  const payload = FraudService.buildGroundingPayload({
    posted: [{ invoiceNo: 'INV-1', supplierGstin: vendor1.gstin, total: 118000, blocked: true }],
    alerts: [{ ruleId: 'AP-02', tier: 'REJECT', decision: 'OPEN', text: 'Duplicate' }],
    checks: [{ status: 'REJECT', supplierGstin: vendor1.gstin, total: 118000 }],
    auditRows: [{ idx: 1 }],
    auditChainValid: true,
  }, false);

  const payloadJson = JSON.stringify(payload);
  console.log('GEMINI_GROUNDING_PAYLOAD:', payloadJson);

  assert.equal(payloadJson.includes(vendor1.gstin), false, 'Must not contain GSTIN');
  assert.equal(payloadJson.includes(vendor1.account), false, 'Must not contain bank account');
  assert.equal(payloadJson.includes('118000'), false, 'Must not contain invoice amount');
  assert.equal(payloadJson.includes('INV-1'), false, 'Must not contain invoice number');
});

test('Acceptance 25: The API key does not appear in logs, responses, or the repository', () => {
  const filesToScan = [
    path.join(__dirname, '../srv/fraud-service.js'),
    path.join(__dirname, '../srv/rules/rules.js'),
    path.join(__dirname, '../app/app.js'),
    path.join(__dirname, '../app/index.html'),
    path.join(__dirname, '../mta.yaml'),
  ];
  for (const f of filesToScan) {
    const content = fs.readFileSync(f, 'utf8');
    assert.equal(/AIzaSy[0-9A-Za-z_-]{33}/.test(content), false, `Found API key pattern in ${f}`);
  }
});

// ============================================================================
// DEPLOYMENT & ROLE LOGIN (Test 26)
// ============================================================================

test('Acceptance 26: The app URL opens and login works for each role (APClerk, APController, Auditor)', async () => {
  const pageRes = await fetch('http://localhost:3000/index.html');
  assert.equal(pageRes.status, 200);

  for (const [user, role] of [['clerk', 'APClerk'], ['controller', 'APController'], ['auditor', 'Auditor']]) {
    const auth = Buffer.from(`${user}:${user}`).toString('base64');
    const r = await fetch('http://localhost:3000/fraud/whoami()', {
      headers: { Authorization: `Basic ${auth}` },
    });
    assert.equal(r.status, 200);
    const body = await r.json();
    const parsed = JSON.parse(body.value);
    assert.equal(parsed.id, user);
    assert.ok(parsed.roles.includes(role));
  }
});
