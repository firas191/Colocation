// Unit tests for the P8 scoring in eval/lib/prompt_metrics.js and for the p8_scam golden set.  Run: node --test n8n/tests/
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { scoreP8, summarizeP8 } = require('../../eval/lib/prompt_metrics.js');

const gold = fs.readFileSync(path.join(__dirname, '../../eval/datasets/p8_scam_v1.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
const TYPES = ['off_platform_payment', 'advance_payment', 'owner_abroad', 'urgency', 'external_contact'];
const W = { off_platform_payment: 30, advance_payment: 30, owner_abroad: 20, urgency: 10, external_contact: 10 };
const msg = 'Je suis au Canada. Envoyez 250 DT par Western Union avant la visite.';
const G = { is_scam: true, signals: ['owner_abroad', 'off_platform_payment', 'advance_payment'], prices: [250] };

test('golden set: 50 unique items, known signal types, labels consistent with the review threshold', () => {
  assert.equal(gold.length, 50);
  assert.equal(new Set(gold.map((x) => x.id)).size, 50);
  for (const x of gold) {
    assert.ok(x.message && x.context.jurisdiction && x.context.today, x.id);
    for (const s of x.gold.signals) assert.ok(TYPES.includes(s), `${x.id} ${s}`);
    const score = x.gold.signals.reduce((a, s) => a + W[s], 0);
    assert.equal(score >= 30, x.gold.is_scam, `${x.id}: gold signals score ${score}`);   // guide rule 4
    for (const p of x.gold.prices) assert.ok(x.message.includes(String(p)), `${x.id}: price ${p} not written`);
  }
  assert.equal(gold.filter((x) => x.gold.is_scam).length, 25);
});

test('a perfect answer: all signals kept, flagged, every price found', () => {
  const out = { signals: [
    { type: 'owner_abroad', quote: 'je suis au canada' },
    { type: 'off_platform_payment', quote: 'par Western Union' },
    { type: 'advance_payment', quote: 'avant la visite' }], prices_in_text: [{ amount: 250, currency: 'TND', context: 'rent' }] };
  const m = scoreP8(out, G, ['fr'], msg);
  assert.equal(m.json_valid, true);
  assert.equal(m.flagged, true);
  assert.equal(m.text_score, 80);
  assert.equal(m.prices_found, 1);
  assert.deepEqual(m.failures, []);
});

test('quotes not in the text and unknown types do not count, as in wf.scam.check', () => {
  const out = { signals: [
    { type: 'owner_abroad', quote: 'je vis en Italie' },
    { type: 'scam', quote: 'Western Union' },
    { type: 'off_platform_payment', quote: 'Western Union' }], prices_in_text: [] };
  const m = scoreP8(out, G, [], msg);
  assert.deepEqual(m.kept, ['off_platform_payment']);
  assert.equal(m.bad_quotes, 1);
  assert.equal(m.unknown_types, 1);
  assert.equal(m.flagged, true);                                    // 30 = review threshold
  assert.ok(m.failures.includes('missed_owner_abroad'));
  assert.ok(m.failures.includes('missed_advance_payment'));
  assert.ok(m.failures.includes('quote_not_in_text'));
  assert.ok(m.failures.includes('price_missed'));
});

test('an honest listing flagged by the model is a false alert; a missing answer is json_invalid and a missed scam', () => {
  const honest = { is_scam: false, signals: [], prices: [420] };
  let m = scoreP8({ signals: [{ type: 'advance_payment', quote: 'caution un mois' }], prices_in_text: [{ amount: 420 }] },
    honest, [], 'Chambre 420 DT, caution un mois à la signature.');
  assert.equal(m.flagged, true);
  assert.ok(m.failures.includes('false_alert'));
  assert.ok(m.failures.includes('extra_advance_payment'));
  m = scoreP8(null, G, [], msg);
  assert.equal(m.json_valid, false);
  assert.ok(m.failures.includes('json_invalid'));
  assert.ok(m.failures.includes('missed_scam'));
});

test('summary: f1, scam recall, false alert rate, hallucination rate, by tag', () => {
  const ok = scoreP8({ signals: [{ type: 'off_platform_payment', quote: 'Western Union' }, { type: 'advance_payment', quote: 'avant la visite' },
    { type: 'owner_abroad', quote: 'au Canada' }], prices_in_text: [{ amount: 250 }] }, G, ['fr', 'scam'], msg);
  const miss = scoreP8({ signals: [], prices_in_text: [] }, G, ['ar', 'scam'], msg);
  const alert = scoreP8({ signals: [{ type: 'off_platform_payment', quote: 'invented quote' }, { type: 'advance_payment', quote: 'caution' }],
    prices_in_text: [] }, { is_scam: false, signals: [], prices: [] }, ['fr', 'honest'], 'Chambre, caution à la signature.');
  const s = summarizeP8([
    { metrics: ok, tags: ['fr', 'scam'], latency_ms: 1000 },
    { metrics: miss, tags: ['ar', 'scam'], latency_ms: 3000 },
    { metrics: alert, tags: ['fr', 'honest'], latency_ms: 2000, call_error: false }]);
  assert.equal(s.items, 3);
  assert.equal(s.scam_recall, 0.5);
  assert.equal(s.false_alert_rate, 1);
  assert.equal(s.hallucination_rate, 0.2);                           // 1 bad quote of 5
  assert.equal(s.precision, 0.75);                                   // 3 tp, 1 fp
  assert.equal(s.recall, 0.5);                                       // 3 tp, 3 fn
  assert.equal(s.latency_p95_ms, 3000);
  assert.equal(s.by_tag.ar.scam_recall, 0);
  assert.equal(s.by_tag.fr.items, 2);
});
