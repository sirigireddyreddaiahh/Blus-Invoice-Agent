'use strict';
const assert = require('assert');

async function runTests() {
  const testInputs = [
    // Greetings (1-10)
    { q: 'hi', type: 'greeting' },
    { q: 'helo', type: 'greeting' },
    { q: 'HELO', type: 'greeting' },
    { q: 'hello', type: 'greeting' },
    { q: 'good morning', type: 'greeting' },
    { q: 'good evening', type: 'greeting' },
    { q: 'good afternoon', type: 'greeting' },
    { q: 'hey', type: 'greeting' },
    { q: 'hi there', type: 'greeting' },
    { q: 'greetings', type: 'greeting' },

    // Politics / Off-topic Refusals (11-25)
    { q: 'politics', type: 'refusal' },
    { q: 'tell me about politics', type: 'refusal' },
    { q: 'who is the president', type: 'refusal' },
    { q: 'election news', type: 'refusal' },
    { q: 'what is the weather', type: 'refusal' },
    { q: 'is it raining outside', type: 'refusal' },
    { q: 'who won cricket match', type: 'refusal' },
    { q: 'tell me a joke', type: 'refusal' },
    { q: 'best movie of 2026', type: 'refusal' },
    { q: 'what is recipe for cake', type: 'refusal' },
    { q: 'who is prime minister', type: 'refusal' },
    { q: 'football score', type: 'refusal' },
    { q: 'tell me a story', type: 'refusal' },
    { q: 'capital of France', type: 'refusal' },
    { q: 'another vendor invoice', type: 'refusal' },

    // Valid Invoice / Rules / Ledger Questions (26-50)
    { q: 'is this real or fake', type: 'invoice' },
    { q: 'why was invoice blocked', type: 'invoice' },
    { q: 'what is the invoice number', type: 'invoice' },
    { q: 'how much is the total amount', type: 'invoice' },
    { q: 'who is the supplier', type: 'invoice' },
    { q: 'what is supplier GSTIN', type: 'invoice' },
    { q: 'bank account is same or not', type: 'invoice' },
    { q: 'what is IFSC code', type: 'invoice' },
    { q: 'what rules were checked', type: 'invoice' },
    { q: 'explain rule AP-02', type: 'invoice' },
    { q: 'explain rule AP-03', type: 'invoice' },
    { q: 'explain rule AP-09', type: 'invoice' },
    { q: 'explain rule AP-11', type: 'invoice' },
    { q: 'is invoice in database', type: 'invoice' },
    { q: 'search ledger for SSFS', type: 'invoice' },
    { q: 'search database for TechVision', type: 'invoice' },
    { q: 'show me review queue count', type: 'invoice' },
    { q: 'show me check history count', type: 'invoice' },
    { q: 'show me summary stats', type: 'invoice' },
    { q: 'show activity log', type: 'invoice' },
    { q: 'what is the posting date', type: 'invoice' },
    { q: 'is GSTIN valid', type: 'invoice' },
    { q: 'is there any split invoice pattern', type: 'invoice' },
    { q: 'is there repeat bill within 90 days', type: 'invoice' },
    { q: 'can I post this to ledger', type: 'invoice' }
  ];

  console.log(`Testing ${testInputs.length} questions against /fraud/askInvoice...`);

  let passCount = 0;
  let failCount = 0;

  for (let i = 0; i < testInputs.length; i++) {
    const item = testInputs[i];
    try {
      const res = await fetch('http://localhost:3000/fraud/askInvoice', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-User-Role': 'APClerk' },
        body: JSON.stringify({ checkId: '', question: item.q })
      });
      const data = await res.json();
      const reply = data.value || '';

      const hasDumpedInvoiceDetails = reply.includes('Invoice details from current check:');

      if (item.type === 'greeting') {
        assert.equal(hasDumpedInvoiceDetails, false, `[Test ${i+1}] "${item.q}" must NOT dump invoice details`);
        assert.match(reply, /Blus Invoice Agent/i, `[Test ${i+1}] "${item.q}" should contain greeting`);
      } else if (item.type === 'refusal') {
        assert.equal(hasDumpedInvoiceDetails, false, `[Test ${i+1}] "${item.q}" must NOT dump invoice details`);
        assert.match(reply, /I can only answer questions about/i, `[Test ${i+1}] "${item.q}" should get refusal message`);
      } else if (item.type === 'invoice') {
        assert.notEqual(reply, 'I can only answer questions about this invoice check.', `[Test ${i+1}] "${item.q}" should be answered`);
      }

      passCount++;
      console.log(`✓ Test ${i+1}/50 [${item.type}] "${item.q}" -> OK`);
    } catch (err) {
      failCount++;
      console.error(`✗ Test ${i+1}/50 FAIL for "${item.q}":`, err.message);
    }
  }

  console.log(`\n========================================`);
  console.log(`Results: ${passCount}/${testInputs.length} PASSED (${failCount} FAILED)`);
  console.log(`========================================`);
  if (failCount > 0) process.exit(1);
}

runTests();
