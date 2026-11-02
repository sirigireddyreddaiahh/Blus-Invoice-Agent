'use strict';
const { RULES } = require('./rules');

const REQUIRED = ['supplierGstin', 'invoiceNo', 'invoiceDate', 'total'];

// Overall status: REJECT beats HOLD beats FLAG beats PASS. SKIPPED and DISABLED do not count.
function overall(results) {
  const tiers = results.map(r => r.tier);
  if (tiers.includes('REJECT')) return 'REJECT';
  if (tiers.includes('HOLD')) return 'HOLD';
  if (tiers.includes('FLAG')) return 'FLAG';
  return 'PASS';
}

function runRules(inv, ctx) {
  const missing = REQUIRED.filter(k => inv[k] === undefined || inv[k] === null || inv[k] === '');
  if (missing.length) {
    return {
      status: 'HOLD',
      results: [{
        id: 'INPUT',
        title: 'Input completeness',
        tier: 'HOLD',
        text: `Missing required fields: ${missing.join(', ')}. Complete the invoice before checking.`,
      }],
    };
  }
  const results = RULES.map(rule => {
    try {
      const out = rule.run(inv, ctx);
      return { id: rule.id, title: rule.title, tier: out.tier, text: out.text };
    } catch (e) {
      return { id: rule.id, title: rule.title, tier: 'HOLD', text: `This check could not run (${e.message}). Review manually.` };
    }
  });
  return { status: overall(results), results };
}

module.exports = { runRules, overall };
