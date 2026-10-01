// Unit tests for eval/lib/metrics.js.  Run: node --test eval/tests/
const test = require('node:test');
const assert = require('node:assert/strict');
const { queryMetrics, matchedGold } = require('../lib/metrics.js');

const D = 'doc-1';
const gold = [{ document_id: D, start: 1000, end: 1400, found: true }];
const ch = (s, e, d = D) => ({ document_id: d, start_char: s, end_char: e });

test('relevance: overlap of at least half of the shorter span', () => {
  assert.deepEqual(matchedGold(ch(900, 1500), gold, 0.5), [0]);   // covers the gold span
  assert.deepEqual(matchedGold(ch(1100, 1200), gold, 0.5), [0]);  // small chunk inside the gold span
  assert.deepEqual(matchedGold(ch(1300, 1900), gold, 0.5), []);   // 100 of 400 chars
  assert.deepEqual(matchedGold(ch(1000, 1400, 'doc-2'), gold, 0.5), []);
  assert.deepEqual(matchedGold(ch(0, 1000), gold, 0.5), []);      // touching, no overlap
});

test('hit, recall, mrr and ndcg with per-gold credit', () => {
  const g2 = [...gold, { document_id: D, start: 5000, end: 5300, found: true }];
  const m = queryMetrics([ch(0, 500), ch(1000, 1200), ch(1200, 1400), ch(5000, 5300)], g2, 0.5);
  assert.equal(m['hit@1'], 0);
  assert.equal(m['hit@3'], 1);
  assert.equal(m['recall@3'], 0.5);         // the second chunk of the same gold span gets no extra credit
  assert.equal(m['recall@5'], 1);
  assert.equal(m.mrr, 0.5);
  const dcg = 1 / Math.log2(3) + 1 / Math.log2(5);
  const idcg = 1 + 1 / Math.log2(3);
  assert.ok(Math.abs(m['ndcg@10'] - dcg / idcg) < 1e-12);
  assert.deepEqual(m.relevant_ranks, [2, 3, 4]);
});

test('nothing retrieved, and queries without usable gold', () => {
  const m = queryMetrics([], gold, 0.5);
  assert.equal(m['hit@10'], 0);
  assert.equal(m.mrr, 0);
  assert.equal(m['ndcg@10'], 0);
  const none = queryMetrics([ch(1000, 1400)], [{ document_id: D, start: null, end: null, found: false }], 0.5);
  assert.equal(none.gold_spans, 0);
  assert.equal(none['hit@1'], null);
  assert.equal(none.mrr, null);
});
