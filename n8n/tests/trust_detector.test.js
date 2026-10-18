// D-114: Emna Safer's detector answer and price_mismatch inside the trust check (n8n/src/lib/trust_rules.js)
const test = require('node:test');
const assert = require('node:assert/strict');
const { detectorAsAgent, priceMismatch, checkAgent, numbersIn } = require('../src/lib/trust_rules.js');

const L = { rent_minor: 300000, exponent: 3, rent_period: 'month', currency: 'TND' };
const TEXT = 'Studio S+1 à La Marsa, 300 DT par mois. Le loyer réel est de 900 DT, les 300 DT sont pour les frais de dossier à payer avant la visite.';

test('numbers with the usual separators', () => {
  const n = numbersIn('1 200 DT, 1.200, 1,200 ou 1200.50');
  for (const x of [1200, 1200.5]) assert.ok(n.has(x), String(x));
});

test('a rent in the text far from the stored rent is price_mismatch; other amounts are not', () => {
  const r = priceMismatch(L, [{ amount: 300, currency: 'TND', context: 'monthly rent' }, { amount: 900, currency: 'TND', context: 'real rent' }], TEXT);
  assert.equal(r.signal.signal, 'price_mismatch');
  assert.equal(r.signal.evidence.text_amount, 900);
  assert.equal(priceMismatch(L, [{ amount: 900, currency: 'TND', context: 'deposit' }], TEXT).signal, null, 'a deposit is not the rent');
  assert.equal(priceMismatch(L, [{ amount: 900, currency: 'EUR', context: 'rent' }], TEXT).signal, null, 'another currency');
  const wk = { rent_minor: 11000, exponent: 2, rent_period: 'week', currency: 'GBP' };
  assert.equal(priceMismatch(wk, [{ amount: 476, currency: 'GBP', context: 'rent per month' }], 'Room, 110 GBP per week (476 GBP per month).').signal, null,
    'a weekly rent quoted per month is not a mismatch');
});

test('an amount the model gives but the text does not have is dropped', () => {
  const r = priceMismatch(L, [{ amount: 950, currency: 'TND', context: 'real rent' }], TEXT);
  assert.equal(r.signal, null);
  assert.deepEqual(r.dropped, [{ signal: 'price_mismatch', why: 'amount_not_in_text' }]);
});

test('the detector answer goes through the agent checks: quote in the text, payment confirmed by a rule', () => {
  const raw = detectorAsAgent({ signals: [
    { type: 'advance_payment', quote: 'frais de dossier à payer avant la visite', evidence: 'fee before visit' },
    { type: 'owner_abroad', quote: 'je suis au Canada', evidence: 'invented' },
    { type: 'urgency', quote: 'Le loyer réel', evidence: 'x' }], prices_in_text: [] });
  const withRule = checkAgent(raw, TEXT, [{ signal: 'payment_before_viewing' }], 'detector');
  assert.deepEqual(withRule.kept.map((x) => [x.signal, x.points, x.source]),
    [['payment_before_viewing', null, 'detector'], ['urgency_pressure', null, 'detector']], 'no points: the setting decides');
  assert.deepEqual(withRule.dropped, [{ signal: 'owner_abroad', why: 'quote_not_in_text' }]);
  const noRule = checkAgent(raw, TEXT, [], 'detector');
  assert.equal(noRule.kept[0].signal, 'payment_claim_unconfirmed');
  assert.equal(withRule.summary, 'fee before visit; invented; x');
});
