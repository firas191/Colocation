// wf.eval.retrieval > "Score"
// Input: one eval.timed_search answer per query, in query order.
// Per-query metrics (eval/lib/metrics.js) and the run summary.
/* @include eval/lib/metrics.js */
const plan = $('Start job').first().json;
const loopItem = $('Loop configs').first().json;
const run = $('Create run').first().json;
const frac = loopItem.config.overlap_fraction;
const answers = $input.all().map((i) => i.json.r);
if (answers.length !== plan.queries.length) throw new Error(`${answers.length} search answers for ${plan.queries.length} queries`);
const rows = [];
const sums = {};
let nScored = 0;
const lat = [];
plan.queries.forEach((q, i) => {
  const a = answers[i];
  const retrieved = (a.results || []).map((r) => ({
    chunk_id: r.chunk_id, rank: r.rank, score: r.score, dense_rank: r.dense_rank, lexical_rank: r.lexical_rank,
    dense_similarity: r.dense_similarity, document_id: r.document_id, start_char: r.start_char, end_char: r.end_char,
    source_key: r.source_key, source_type: r.source_type, article_ref: r.article_ref,
  }));
  const m = queryMetrics(retrieved, q.gold || [], frac);
  m.search_ms = a.ms;
  m.embed_ms_amortised = loopItem.config.mode === 'lexical' ? 0 : loopItem.embed_ms_per_query;
  lat.push(m.search_ms + m.embed_ms_amortised);
  if (m.gold_spans > 0) {
    nScored++;
    for (const [k, v] of Object.entries(m)) if (typeof v === 'number' && /@|mrr/.test(k)) sums[k] = (sums[k] || 0) + v;
  }
  rows.push({ run_id: run.id, query_id: q.id, retrieved, metrics: m });
});
const summary = { queries: plan.queries.length, scored: nScored };
for (const [k, v] of Object.entries(sums)) summary[k] = Math.round((v / nScored) * 10000) / 10000;
lat.sort((a, b) => a - b);
const pct = (p) => lat.length ? lat[Math.min(lat.length - 1, Math.ceil(p * lat.length) - 1)] : null;
summary.latency_ms_p50 = pct(0.5);
summary.latency_ms_p95 = pct(0.95);
return [{ json: { run_id: run.id, rows: JSON.stringify(rows), summary: JSON.stringify(summary) } }];
