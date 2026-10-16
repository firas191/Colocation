// Unit tests for n8n/src/lib/scam_signals.js (A4 scam check).  Run: node --test n8n/tests/
const test = require('node:test');
const assert = require('node:assert/strict');
const { scamScore, quoteInText, normCurrency } = require('../src/lib/scam_signals.js');

const S = {
  'scam.weights': { price_very_low: 35, price_low: 15, price_high: 5, price_very_high: 10, price_mismatch: 25,
    new_account: 10, unverified_owner: 10, listing_burst: 15,
    off_platform_payment: 30, advance_payment: 30, owner_abroad: 20, urgency: 10, external_contact: 15 },
  'scam.price_ratio': { very_low: 0.4, low: 0.6, high: 1.6, very_high: 2.5 },
  'scam.thresholds': { review: 30, block: 65 },
  'scam.new_account_days': 7, 'scam.burst_listings_24h': 5 };
const ctx = (o) => ({ listing_id: 'l1', text: 'Chambre meublee a Tunis, proche metro.', jurisdiction_code: 'TN',
  rent_minor: 450000, rent_period: 'month', rent_scope: 'per_room', currency: 'TND', currency_exponent: 3,
  market: { median_monthly_minor: 450000, scope: 'city', comparables: 20 },
  owner: { account_age_days: 400, verified_level: 1, listings_24h: 0 }, settings: S, ...o });
const BAD_OWNER = { account_age_days: 2, verified_level: 0, listings_24h: 6 };
const types = (r) => r.signals.map((s) => s.type);

test('a normal listing without model output scores 0 (low)', () => {
  const r = scamScore(ctx({}), null);
  assert.equal(r.score, 0);
  assert.equal(r.level, 'low');
  assert.deepEqual(r.signals, []);
});

test('price far below the median is flagged; half weight when the median is jurisdiction-wide', () => {
  let r = scamScore(ctx({ rent_minor: 150000 }), null);
  assert.deepEqual(types(r), ['price_very_low']);
  assert.equal(r.signals[0].weight, 35);
  assert.equal(r.signals[0].evidence.ratio, 0.33);
  r = scamScore(ctx({ rent_minor: 150000, market: { median_monthly_minor: 450000, scope: 'jurisdiction', comparables: 40 } }), null);
  assert.equal(r.signals[0].weight, 18);
  r = scamScore(ctx({ rent_minor: 150000, rent_scope: 'whole_flat' }), null);
  assert.deepEqual(r.signals, []);                                   // whole flat is not compared to rooms
});

test('weekly rents are compared per month to the median', () => {
  const r = scamScore(ctx({ rent_minor: 20000, rent_period: 'week', currency: 'GBP', currency_exponent: 2,
    market: { median_monthly_minor: 90000, scope: 'city', comparables: 12 } }), null);
  assert.deepEqual(r.signals, []);                                   // 200 pw = 866.67 a month, ratio 0.96
});

test('price_mismatch: a rent in the text far from the stored rent', () => {
  const m = (p) => scamScore(ctx({}), { signals: [], prices_in_text: [p] });
  let r = m({ amount: 900, currency: 'DT', context: 'le vrai loyer est 900 dt' });
  assert.deepEqual(types(r), ['price_mismatch']);
  assert.equal(r.signals[0].evidence.text_amount, 900);
  assert.equal(r.signals[0].evidence.ratio, 2);
  r = m({ amount: 900, currency: 'TND', context: 'Loyer 900 DT charges comprises' });
  assert.deepEqual(types(r), ['price_mismatch']);                   // "charges" no longer hides a rent
  r = m({ amount: 900, currency: 'TND', context: 'prix des frais : 900 dt' });
  assert.deepEqual(r.signals, []);                                   // fees, not a rent
  r = m({ amount: 900, currency: 'TND', context: 'caution 900 dt' });
  assert.deepEqual(r.signals, []);                                   // deposit, not a rent
  r = m({ amount: 900, currency: 'EUR', context: 'loyer 900 eur' });
  assert.deepEqual(r.signals, []);                                   // other currency, not compared
  r = m({ amount: 900, currency: 'TND', context: 'current offer 900' });
  assert.deepEqual(r.signals, []);                                   // "current" is not "rent"
  r = m({ amount: 470, currency: 'TND', context: 'loyer 470 dt' });
  assert.deepEqual(r.signals, []);                                   // close to the stored rent
});

test('price_mismatch: a weekly rent quoted per month is not a mismatch', () => {
  const c = ctx({ rent_minor: 20000, rent_period: 'week', currency: 'GBP', currency_exponent: 2,
    market: { median_monthly_minor: 90000, scope: 'city', comparables: 12 } });
  for (const amount of [900, 1000]) {
    const r = scamScore(c, { signals: [], prices_in_text: [{ amount, currency: '£', context: `£${amount} per month` }] });
    assert.deepEqual(r.signals, [], `amount ${amount}`);
  }
});

test('model signals are kept only with a known type and a quote found in the text', () => {
  const text = "Chambre a Tunis. Envoyez l'avance par Western Union, je suis à l'étranger.";
  const r = scamScore(ctx({ text }), { prices_in_text: [], signals: [
    { type: 'off_platform_payment', quote: 'Western Union' },
    { type: 'owner_abroad', quote: "je suis a l'etranger" },        // accents ignored
    { type: 'urgency', quote: 'répondez vite' },                    // not in the text
    { type: 'hack', quote: 'Chambre' },                             // unknown type
    { type: 'external_contact', quote: 'wu' },                      // quote too short
    { type: 'off_platform_payment', quote: "l'avance" } ] });       // duplicate type, ignored
  assert.deepEqual(types(r), ['off_platform_payment', 'owner_abroad']);
  assert.deepEqual(r.dropped, [
    { type: 'urgency', reason: 'quote_not_in_text' },
    { type: 'hack', reason: 'unknown_type' },
    { type: 'external_contact', reason: 'quote_not_in_text' }]);
  assert.equal(r.score, 50);
  assert.equal(r.level, 'medium');
});

test('profile rules still apply when the model is unavailable', () => {
  const r = scamScore(ctx({ owner: BAD_OWNER }), null);
  assert.deepEqual(types(r), ['new_account', 'unverified_owner', 'listing_burst']);
  assert.equal(r.score, 35);
  assert.equal(r.level, 'medium');
});

test('the score is capped at 100 and reaches high', () => {
  const r = scamScore(ctx({ rent_minor: 150000, owner: BAD_OWNER, text: 'Paiement par Western Union, urgent.' }),
    { prices_in_text: [], signals: [{ type: 'off_platform_payment', quote: 'western union' }, { type: 'urgency', quote: 'urgent' }] });
  assert.equal(r.score, 100);                                        // 35 + 35 + 30 + 10 = 110
  assert.equal(r.level, 'high');
});

test('missing settings throw instead of scoring every listing low', () => {
  assert.throws(() => scamScore(ctx({ settings: {} }), null), /scam settings missing/);
  assert.throws(() => scamScore(ctx({ settings: { 'scam.weights': S['scam.weights'] } }), null), /scam\.price_ratio/);
});

test('helpers', () => {
  assert.equal(normCurrency('DT'), 'TND');
  assert.equal(normCurrency('€'), 'EUR');
  assert.equal(normCurrency(null), null);
  assert.equal(quoteInText('  WESTERN   union ', 'par Western Union'), true);
  assert.equal(quoteInText('abc', 'abc def'), false);               // under 4 characters
});