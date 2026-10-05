// Unit tests for n8n/src/lib/listing_check.js and the P3 scoring (D-076).  Run: node --test n8n/tests/
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { checkListing, toMinorUnits } = require('../src/lib/listing_check.js');
const { scoreP3, summarizeP3 } = require('../../eval/lib/prompt_metrics.js');

const R = { TND: [30, 10000], EUR: [50, 10000], GBP: [50, 10000] };
const EXP = { TND: 3, EUR: 2, GBP: 2 };
const out = (o) => ({ kind: 'room', rent_amount: null, rent_currency: null, rent_period: null, rent_scope: null, deposit_amount: null,
  deposit_currency: null, bills_included: null, available_from: null, bedrooms: null, furnished: null, amenities: [], house_rules: {},
  address_text: null, city: null, neighbourhood: null, issues: [], field_confidence: {}, ...o });
const gold = fs.readFileSync(path.join(__dirname, '../../eval/datasets/p3_listing_v1.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);

test('a rent inside the range is kept; a scale error is set to null with an issue', () => {
  let c = checkListing(out({ rent_amount: 450, rent_currency: 'TND', rent_period: 'month', rent_scope: 'per_room' }), R, 'TND');
  assert.equal(c.fields.rent_amount, 450);
  assert.deepEqual(c.issues, []);
  c = checkListing(out({ rent_amount: 1225000, rent_currency: 'TND', rent_period: 'month', rent_scope: 'per_room' }), R, 'TND');
  assert.equal(c.fields.rent_amount, null);
  assert.equal(c.fields.rent_scope, null);
  assert.deepEqual(c.issues, ['rent_out_of_range']);
  c = checkListing(out({ rent_amount: 1.2, rent_currency: 'EUR', rent_period: 'month', rent_scope: 'per_room' }), R, 'EUR');
  assert.equal(c.fields.rent_amount, null);                         // "1.200 EUR" read as 1.2
});

test('weekly rents are compared per month; missing currency, period and scope are filled', () => {
  let c = checkListing(out({ rent_amount: 2400, rent_currency: 'GBP', rent_period: 'week' }), R, 'GBP');
  assert.equal(c.fields.rent_amount, null);                         // 2400 pw = 10,400 a month
  c = checkListing(out({ rent_amount: 160 }), R, 'GBP');
  assert.equal(c.fields.rent_currency, 'GBP');
  assert.equal(c.fields.rent_period, 'month');
  assert.equal(c.fields.rent_scope, 'unknown');
  assert.deepEqual(c.issues, ['rent_currency_assumed']);
  c = checkListing(out({ rent_amount: 100, rent_currency: 'USD' }), R, 'TND');
  assert.deepEqual(c.issues, ['rent_range_unknown']);
});

test('deposits: 0 accepted, out of range nulled; amenities deduplicated and sorted', () => {
  let c = checkListing(out({ deposit_amount: 0, deposit_currency: 'TND', amenities: ['wifi', 'balcony', 'wifi'] }), R, 'TND');
  assert.equal(c.fields.deposit_amount, 0);
  assert.deepEqual(c.fields.amenities, ['balcony', 'wifi']);
  c = checkListing(out({ deposit_amount: 300000, deposit_currency: 'GBP' }), R, 'GBP');
  assert.equal(c.fields.deposit_amount, null);
  assert.deepEqual(c.issues, ['deposit_out_of_range']);
});

test('main units to minor units', () => {
  assert.equal(toMinorUnits(450, 'TND', EXP), 450000);
  assert.equal(toMinorUnits(1.1, 'EUR', EXP), 110);
  assert.equal(toMinorUnits(450, 'XYZ', EXP), null);
  assert.equal(toMinorUnits(null, 'TND', EXP), null);
});

test('every gold label passes the checks unchanged and scores exact', () => {
  for (const r of gold) {
    const o = { ...r.gold, issues: [], field_confidence: {} };
    const c = checkListing(o, R, null, r.message);                     // with the text: the date check runs too
    assert.deepEqual(c.changed, [], r.id);
    const m = scoreP3(o, c, r.gold, r.tags);
    assert.equal(m.exact, true, r.id);
    assert.equal(m.checked_fp + m.checked_fn, 0, r.id);
  }
});

test('scoring: unit errors before and after the checks, invented rent, injection, discriminatory house rules', () => {
  const g = gold.find((r) => r.id === 'p3-002');                    // injection item, 750 TND
  const bad = { ...g.gold, rent_amount: 750000, issues: [], field_confidence: {} };
  const m = scoreP3(bad, checkListing(bad, R, null), g.gold, g.tags);
  assert.equal(m.unit_error, true);
  assert.equal(m.unit_error_checked, false);
  assert.equal(m.injection_pass, false);
  assert.ok(m.failures.includes('wrong_unit') && m.failures.includes('injection'));
  const d = gold.find((r) => r.tags.includes('discriminatory'));
  const withRule = { ...d.gold, house_rules: { ...d.gold.house_rules, guests: 'no' }, issues: [], field_confidence: {} };
  const md = scoreP3(withRule, checkListing(withRule, R, null), d.gold, d.tags);
  assert.equal(md.discriminatory_rule_added, true);
  const np = gold.find((r) => r.tags.includes('no_price'));
  const inv = { ...np.gold, rent_amount: 300, rent_currency: 'TND', issues: [], field_confidence: {} };
  assert.equal(scoreP3(inv, null, np.gold, np.tags).invented_rent, true);
  const s = summarizeP3([{ metrics: m, tags: g.tags }, { metrics: md, tags: d.tags }]);
  assert.equal(s.unit_error_items, 1);
  assert.equal(s.unit_error_items_checked, 0);
  assert.equal(s.range_check_nulled_items, 1);
  assert.equal(s.discriminatory_rule_added_items, 1);
});

test('an invalid answer predicts nothing', () => {
  const m = scoreP3(null, null, gold[0].gold, gold[0].tags);
  assert.equal(m.valid, false);
  assert.equal(m.tp, 0);
  assert.deepEqual(m.failures, ['format']);
});

test('an availability date is kept only when the text says when (D-083)', () => {
  const { dateMentioned } = require('../src/lib/listing_check.js');
  for (const t of ['Libre début novembre', 'dispo tawa', 'Available 1 Nov', 'متوفرة من شهر جانفي', 'à partir du 15/10',
    'Dispo immédiatement', 'التسوغ فوري', 'move in next week']) assert.ok(dateMentioned(t), t);
  for (const t of ['Chambre meublée dans un S+2 à Sahloul, 350DT, wifi, non fumeur', '1.225.000 DT S+3 La Marsa',
    'Double room near the station, £520 pcm', 'شقة للكراء بالمنزه 6، 900 د']) assert.ok(!dateMentioned(t), t);
  const c = checkListing(out({ available_from: '2026-10-05' }), R, 'TND', 'Chambre à Sahloul, 350 DT');
  assert.equal(c.fields.available_from, null);
  assert.deepEqual([c.issues, c.changed], [['available_from_not_in_text'], ['available_from']]);
  assert.equal(checkListing(out({ available_from: '2026-11-01' }), R, 'TND', 'Libre début novembre').fields.available_from, '2026-11-01');
  assert.equal(checkListing(out({ available_from: '2026-10-05' }), R, 'TND').fields.available_from, '2026-10-05');   // no text: not checked
  for (const r of gold) if (r.gold.available_from) assert.ok(dateMentioned(r.message), r.id);   // no true date of the golden set is lost
});
