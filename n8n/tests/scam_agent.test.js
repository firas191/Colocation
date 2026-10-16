// Unit tests for the A4 Scam agent: reading its final answer (lib/scam_agent.js) and the contact_reused rule
// (lib/scam_signals.js).  Run: node --test n8n/tests/
const test = require('node:test');
const assert = require('node:assert/strict');
const { scamParseAnswer, scamContactReuse } = require('../src/lib/scam_agent.js');
const { scamScore, contactInText } = require('../src/lib/scam_signals.js');

const S = {
  'scam.weights': { price_low: 15, price_mismatch: 25, new_account: 10, unverified_owner: 10, listing_burst: 15,
    off_platform_payment: 30, advance_payment: 30, owner_abroad: 20, urgency: 10, external_contact: 15 },
  'scam.price_ratio': { very_low: 0.4, low: 0.6, high: 1.6, very_high: 2.5 },
  'scam.thresholds': { review: 30, block: 65 } };
const ctx = (o) => ({ listing_id: 'l1', text: 'Chambre à Tunis. WhatsApp +216 20 345 678 ou ali.coloc@mail.tn', rent_minor: 450000,
  rent_period: 'month', currency: 'TND', currency_exponent: 3, market: { median_monthly_minor: 450000, scope: 'city', comparables: 20 },
  owner: { account_age_days: 400, verified_level: 1, listings_24h: 0 }, settings: S, ...o });

test('the final answer is read even with text or a code fence around the JSON', () => {
  const a = scamParseAnswer('Voici :\n```json\n{"signals":[{"type":"urgency","quote":"vite","evidence":"x"}],"prices_in_text":[{"amount":450,"currency":"TND","context":"rent"}],"note":"Compte de 1 jour."}\n```');
  assert.equal(a.signals.length, 1);
  assert.equal(a.prices_in_text[0].amount, 450);
  assert.equal(a.note, 'Compte de 1 jour.');
  assert.equal(scamParseAnswer('no json here'), null);
  assert.equal(scamParseAnswer('{"verdict": "scam"}'), null);                 // no signals list: not trusted
  assert.deepEqual(scamParseAnswer('{"signals": []}').prices_in_text, []);
});

test('contact_reuse results come from the tool outputs (object or JSON text)', () => {
  const r = scamContactReuse([
    { tool: 'owner_profile', output: { account_age_days: 1 } },
    { tool: 'contact_reuse', output: '{"contact":"+216 20 345 678","other_listings":3,"other_owners":2}' },
    { tool: 'contact_reuse', output: { contact: 'ali.coloc@mail.tn', other_listings: 0, other_owners: 0 } }]);
  assert.deepEqual(r, [{ contact: '+216 20 345 678', other_listings: 3, other_owners: 2 },
    { contact: 'ali.coloc@mail.tn', other_listings: 0, other_owners: 0 }]);
});

test('a contact must really be written in the listing', () => {
  assert.equal(contactInText('20345678', 'WhatsApp +216 20 345 678'), true);   // last 8 digits
  assert.equal(contactInText('ALI.coloc@mail.tn', 'écrire à ali.coloc@mail.tn'), true);
  assert.equal(contactInText('99 999 999', 'WhatsApp +216 20 345 678'), false);
  assert.equal(contactInText('123', '123'), false);                            // too short to be a phone
});

test('contact_reused: a contact used by other owners adds the signal; an invented contact is dropped', () => {
  let r = scamScore(ctx({}), { signals: [], prices_in_text: [] },
    { contact_reuse: [{ contact: '+216 20 345 678', other_listings: 3, other_owners: 2 }] });
  assert.deepEqual(r.signals.map((s) => s.type), ['contact_reused']);
  assert.equal(r.signals[0].weight, 20);                                       // default until scam.weights has it
  assert.deepEqual(r.signals[0].evidence, { other_listings: 3, other_owners: 2 });
  r = scamScore(ctx({}), null, { contact_reuse: [{ contact: '55 555 555', other_listings: 9, other_owners: 4 }] });
  assert.deepEqual(r.signals, []);
  assert.deepEqual(r.dropped, [{ type: 'contact_reused', reason: 'contact_not_in_text' }]);
  r = scamScore(ctx({}), null, { contact_reuse: [{ contact: 'ali.coloc@mail.tn', other_listings: 0, other_owners: 0 }] });
  assert.deepEqual(r.signals, []);                                             // not reused: nothing
  r = scamScore(ctx({ settings: { ...S, 'scam.weights': { ...S['scam.weights'], contact_reused: 35 } } }), null,
    { contact_reuse: [{ contact: 'ali.coloc@mail.tn', other_listings: 1, other_owners: 1 }] });
  assert.equal(r.signals[0].weight, 35);                                       // the setting wins when present
});
