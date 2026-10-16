const test = require('node:test');
const assert = require('node:assert/strict');
const { minor, proposal } = require('../src/lib/negotiation.js');

test('TND uses integer millimes and rejects fractional or unsafe amounts', () => {
  assert.equal(minor(450000), true);
  for (const value of [450.5, 0, -1, Number.MAX_SAFE_INTEGER, '450000']) assert.equal(minor(value), false);
});

test('model offer is accepted only within asking, budget and counter ceilings', () => {
  const c = { asking_minor: 600000, target_minor: 450000, max_minor: 500000, counter_minor: 480000 };
  assert.deepEqual(proposal('{"offer_minor":470000,"reasoning_summary":"Une offre"}', c),
    { amount_minor: 470000, model_used: true, rationale: 'Une offre' });
  for (const raw of ['{"offer_minor":510000}', '{"offer_minor":480001}', '{"offer_minor":400.5}', 'invalid']) {
    assert.equal(proposal(raw, c).amount_minor, 450000);
    assert.equal(proposal(raw, c).model_used, false);
  }
});
