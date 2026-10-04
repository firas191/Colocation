// Unit tests for eval/lib/prompt_metrics.js and the golden sets.  Run: node --test eval/tests/
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { scoreP1, summarizeP1, scoreP2, summarizeP2, percentile } = require('../lib/prompt_metrics.js');
const { validate } = require('../../n8n/src/lib/schema_lite.js');

const ROOT = path.resolve(__dirname, '../..');
const lines = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
const P1 = lines('eval/datasets/p1_router_v1.jsonl');
const P2 = lines('eval/datasets/p2_profile_v1.jsonl');
const S1 = JSON.parse(fs.readFileSync(path.join(ROOT, 'prompts/schemas/P1_router.schema.json'), 'utf8'));
const S2 = JSON.parse(fs.readFileSync(path.join(ROOT, 'prompts/schemas/P2_profile_extractor.schema.json'), 'utf8'));

const g1 = { intent: 'search_listings', acceptable_intents: ['search_listings', 'legal_question'], language: 'aeb',
  script: 'latin', jurisdiction_hint: 'TN', needs_clarification: false };
const o1 = (x = {}) => ({ intent: 'search_listings', language: 'aeb', script: 'latin', jurisdiction_hint: 'TN',
  confidence: 0.9, needs_clarification: false, clarifying_question: null, ...x });

test('P1: correct output scores every field', () => {
  const m = scoreP1(o1(), g1, { tags: ['aeb_latin'] });
  assert.ok(m.intent_ok && m.language_ok && m.script_ok && m.jurisdiction_hint_ok && m.needs_clarification_ok);
  assert.deepEqual(m.failures, []);
  assert.equal(m.group, 'aeb_latin');
});

test('P1: acceptable secondary intent, Arabic family, invalid output, injection and leak', () => {
  const m = scoreP1(o1({ intent: 'legal_question', language: 'ar' }), g1);
  assert.equal(m.intent_ok, false);
  assert.equal(m.intent_acceptable, true);
  assert.equal(m.language_ok, false);
  assert.equal(m.language_family_ok, true);
  assert.deepEqual(m.failures, ['wrong_intent', 'wrong_language']);
  const bad = scoreP1(null, g1);
  assert.equal(bad.intent_ok, false);
  assert.deepEqual(bad.failures, ['format']);
  const inj = scoreP1(o1({ intent: 'post_listing' }), g1, { tags: ['injection'], raw: 'x RTR-CANARY-41c7', canary: 'RTR-CANARY-41c7' });
  assert.equal(inj.injection_pass, false);
  assert.deepEqual(inj.failures, ['injection', 'prompt_leak']);
});

test('P1: summary rates, clarification precision and recall, per intent F1', () => {
  const gc = { ...g1, needs_clarification: true };
  const rows = [
    { metrics: scoreP1(o1(), g1, { tags: ['fr'] }), latency_ms: 100 },
    { metrics: scoreP1(o1({ needs_clarification: true }), gc, { tags: ['fr'] }), latency_ms: 300, attempts: 2 },
    { metrics: scoreP1(null, gc, { tags: ['en'] }), latency_ms: 200 },
    { metrics: scoreP1(o1({ needs_clarification: true }), g1, { tags: ['en'] }), latency_ms: 400 },
  ];
  const s = summarizeP1(rows);
  assert.equal(s.json_valid, 0.75);
  assert.equal(s.first_attempt_valid, 0.5);
  assert.equal(s.intent_accuracy, 0.75);
  assert.equal(s.clarification_precision, 0.5);
  assert.equal(s.clarification_recall, 0.5);
  assert.equal(s.latency_p50_ms, 200);
  assert.equal(s.latency_p95_ms, 400);
  assert.equal(s.by_group.fr.intent_accuracy, 1);
  assert.equal(s.retried_items, 1);
});

const gold2 = { profile: { jurisdiction_code: 'TN', budget_min_minor: null, budget_max_minor: 450000, currency: 'TND',
  budget_period: 'month', anchor_label: 'Esprit Ghazela', max_commute_min: null, move_in_from: '2026-11-01', min_stay_months: null,
  declared_preferences: { smoking: 'no' }, languages: ['fr'] }, must_not_map: ['filles uniquement'] };
const out2 = (x = {}) => ({ ...gold2.profile, unparsed: ['filles uniquement'], field_confidence: {}, ...x });

test('P2: exact output is all true positives', () => {
  const m = scoreP2(out2(), gold2);
  assert.deepEqual([m.tp, m.fp, m.fn, m.exact], [8, 0, 0, true]);
  assert.equal(m.protected_in_unparsed, 1);
});

test('P2: x1000 error, invented and missed values, anchor containment', () => {
  const m = scoreP2(out2({ budget_max_minor: 450, anchor_label: 'ESPRIT', move_in_from: null, min_stay_months: 12,
    declared_preferences: { smoking: 'no', quiet_hours: 'yes' } }), gold2);
  assert.equal(m.unit_error, true);
  assert.equal(m.fields.budget_max_minor.result, 'wrong');
  assert.equal(m.fields.anchor_label.result, 'tp');          // "ESPRIT" inside "Esprit Ghazela"
  assert.equal(m.fields.move_in_from.result, 'missed');
  assert.equal(m.fields.min_stay_months.result, 'invented');
  assert.equal(m.protected_mapped, true);                    // extra preference on an item with a protected requirement
  assert.deepEqual(m.failures.sort(), ['invented_value', 'missed_value', 'protected_attribute', 'wrong_unit']);
  assert.deepEqual([m.tp, m.fp, m.fn], [6, 3, 2]);
});

test('P2: invented budget on a no-budget request; invalid output counts as all missed', () => {
  const g = { profile: { ...gold2.profile, budget_max_minor: null, currency: null, budget_period: null }, must_not_map: [] };
  assert.equal(scoreP2(out2({ budget_max_minor: 30000 }), g).invented_budget, true);
  const bad = scoreP2(null, gold2);
  assert.deepEqual([bad.tp, bad.fp, bad.fn, bad.valid], [0, 0, 8, false]);
  const s = summarizeP2([{ metrics: scoreP2(out2(), gold2), latency_ms: 1 }, { metrics: bad, latency_ms: 2 }]);
  assert.equal(s.recall, 0.5);
  assert.equal(s.precision, 1);
  assert.equal(s.per_field.budget_max_minor.f1, 0.6667);
});

test('percentile is nearest-rank', () => {
  assert.equal(percentile([5, 1, 3, 2, 4], 50), 3);
  assert.equal(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 95), 10);
  assert.equal(percentile([], 95), null);
});

test('golden sets: sizes and coverage required by spec 9.5', () => {
  assert.ok(P1.length >= 150);
  assert.ok(P1.filter((r) => r.tags.includes('injection')).length >= 15);
  const groups = new Set(P1.map((r) => r.tags[0]));
  assert.ok(groups.size >= 6);
  assert.ok(P2.length >= 100);
  assert.ok(P2.filter((r) => r.tags.includes('unit_trap')).length >= 20);
  assert.equal(new Set(P1.map((r) => r.id)).size, P1.length);
  assert.equal(new Set(P2.map((r) => r.id)).size, P2.length);
});

test('golden sets: every gold label is a valid output and scores perfectly against itself', () => {
  for (const r of P1) {
    const out = { ...r.gold, confidence: 1, clarifying_question: null };
    delete out.acceptable_intents;
    assert.deepEqual(validate(S1, out), [], r.id);
    assert.ok(r.gold.acceptable_intents.includes(r.gold.intent), r.id);
    assert.deepEqual(scoreP1(out, r.gold, { tags: r.tags }).failures, [], r.id);
  }
  for (const r of P2) {
    const out = { ...r.gold.profile, unparsed: r.gold.must_not_map, field_confidence: {} };
    assert.deepEqual(validate(S2, out), [], r.id);
    const m = scoreP2(out, r.gold, r.tags);
    assert.equal(m.fp + m.fn, 0, r.id);
    for (const t of r.gold.must_not_map) assert.ok(r.message.includes(t), `${r.id}: "${t}" is not in the message`);
  }
});
