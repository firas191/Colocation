// Unit tests for n8n/src/lib/money.js (P2 v3 amounts, D-066).  Run: node --test n8n/tests/
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { amountsToMinor } = require('../src/lib/money.js');
const { scoreP2 } = require('../../eval/lib/prompt_metrics.js');

const EXP = { TND: 3, EUR: 2, GBP: 2, USD: 2, CHF: 2 };
const v3 = (o) => ({ jurisdiction_code: 'TN', budget_min: null, budget_max: null, currency: null, budget_period: null,
  anchor_label: null, max_commute_min: null, move_in_from: null, min_stay_months: null, declared_preferences: {},
  languages: [], unparsed: [], field_confidence: {}, ...o });

test('main units to minor units with the currency exponent', () => {
  const p = amountsToMinor(v3({ budget_min: 300, budget_max: 450, currency: 'TND', field_confidence: { budget_max: 0.9, anchor_label: 0.8 } }), EXP, 'TND');
  assert.equal(p.budget_min_minor, 300000);
  assert.equal(p.budget_max_minor, 450000);
  assert.equal('budget_max' in p, false);
  assert.deepEqual(p.field_confidence, { budget_max_minor: 0.9, anchor_label: 0.8 });
  assert.deepEqual(Object.keys(p).slice(0, 4), ['jurisdiction_code', 'budget_min_minor', 'budget_max_minor', 'currency']);
  assert.equal(amountsToMinor(v3({ budget_max: 1.1, currency: 'EUR' }), EXP).budget_max_minor, 110);    // no float residue
  assert.equal(amountsToMinor(v3({ budget_max: 12.5, currency: 'GBP' }), EXP).budget_max_minor, 1250);
  assert.equal(amountsToMinor(v3({ budget_max: 1.5, currency: 'TND' }), EXP).budget_max_minor, 1500);  // 1.5 dinars, as given
});

test('no currency: the fallback currency; unknown currency: no amount; v2 output unchanged', () => {
  const p = amountsToMinor(v3({ budget_max: 450 }), EXP, 'TND');
  assert.equal(p.budget_max_minor, 450000);
  assert.equal(p.currency, null);                                   // the currency stays what the model said
  assert.equal(amountsToMinor(v3({ budget_max: 450 }), EXP, null).budget_max_minor, null);
  assert.equal(amountsToMinor(v3({ budget_max: 450, currency: 'CAD' }), EXP, 'TND').budget_max_minor, null);
  const v2 = { budget_min_minor: null, budget_max_minor: 450000, currency: 'TND' };
  assert.equal(amountsToMinor(v2, EXP, 'TND'), v2);
  assert.equal(amountsToMinor(null, EXP, 'TND'), null);
});

test('every P2 gold profile written in main units scores perfectly after conversion', () => {
  const rows = fs.readFileSync(path.join(__dirname, '../../eval/datasets/p2_profile_v1.jsonl'), 'utf8').split('\n').filter(Boolean).map(JSON.parse);
  const DEF = { TN: 'TND', FR: 'EUR', GB: 'GBP' };
  for (const r of rows) {
    const g = r.gold.profile;
    const e = g.currency ? EXP[g.currency] : null;
    const major = { ...g, budget_min: g.budget_min_minor === null ? null : g.budget_min_minor / 10 ** e,
      budget_max: g.budget_max_minor === null ? null : g.budget_max_minor / 10 ** e, unparsed: r.gold.must_not_map, field_confidence: {} };
    delete major.budget_min_minor; delete major.budget_max_minor;
    const m = scoreP2(amountsToMinor(major, EXP, DEF[r.context.jurisdiction]), r.gold, r.tags);
    assert.equal(m.exact, true, r.id);
    assert.equal(m.unit_error, false, r.id);
  }
});
