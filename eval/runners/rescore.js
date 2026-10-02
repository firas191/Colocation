// Score the retrieved lists of an evaluation dump against another gold set, without the
// database: same metrics code as the n8n workflow (eval/lib/metrics.js), gold quotes resolved
// like eval.resolve_gold against the exported texts.
//   node eval/runners/rescore.js <dump.json> <dataset.jsonl> <packs dir> [out.json]
// Prints mean metrics per configuration; with out.json, writes per-query metrics too.
// Used to check a new gold version before running it on the stack (T-34), and to verify that
// rescoring the dump with the gold it was run with reproduces the stored metrics.
const fs = require('fs');
const path = require('path');
const { queryMetrics } = require('../lib/metrics.js');

const [dumpPath, dataPath, packs, outPath] = process.argv.slice(2);
const dump = JSON.parse(fs.readFileSync(dumpPath, 'utf8'));
const queries = fs.readFileSync(dataPath, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));

const texts = {};
for (const pack of fs.readdirSync(packs)) {
  const dir = path.join(packs, pack, 'documents');
  if (!fs.existsSync(dir)) continue;
  for (const key of fs.readdirSync(dir)) {
    const f = path.join(dir, key, 'clean.txt');
    if (fs.existsSync(f)) texts[key] = fs.readFileSync(f, 'utf8');
  }
}
// document ids as stored in the database, from the dump
const docId = {};
for (const res of Object.values(dump.results)) for (const q of Object.values(res)) for (const r of q.retrieved || []) docId[r.source_key] = r.document_id;
for (const spans of Object.values(dump.gold || {})) for (const g of spans) if (g.document_id) docId[g.source_key] = g.document_id;

function countOf(t, s) { let n = 0, i = -1; while ((i = t.indexOf(s, i + 1)) >= 0) n++; return n; }
function resolve(sp) {
  const t = texts[sp.source_key];
  if (t === undefined) throw new Error(`no text for ${sp.source_key}`);
  const s = t.indexOf(sp.start);
  if (s < 0 || countOf(t, sp.start) !== 1) throw new Error(`start quote not found once in ${sp.source_key}`);
  const e = t.indexOf(sp.end, s);
  if (e < 0) throw new Error(`end quote not found in ${sp.source_key}`);
  if (!docId[sp.source_key]) throw new Error(`no document id for ${sp.source_key} in the dump`);
  return { document_id: docId[sp.source_key], start: s, end: e + sp.end.length, found: true };
}
const gold = Object.fromEntries(queries.map((q) => [q.id, q.gold.spans.map(resolve)]));

const out = {};
const label = (c) => `${c.strategy === 'fixed_500_50' ? 'A' : 'B'} ${c.model} ${c.mode}`;
const metricsNames = ['hit@1', 'hit@5', 'hit@10', 'recall@5', 'recall@10', 'mrr', 'ndcg@10'];
for (const run of dump.runs) {
  const res = dump.results[run.id] || {};
  const per = {};
  const sums = {};
  let n = 0;
  for (const q of queries) {
    if (!res[q.id]) continue;
    const m = queryMetrics(res[q.id].retrieved || [], gold[q.id], run.config.overlap_fraction || 0.5);
    per[q.id] = m;
    if (m.gold_spans > 0) { n++; for (const k of metricsNames) sums[k] = (sums[k] || 0) + m[k]; }
  }
  const summary = Object.fromEntries(metricsNames.map((k) => [k, Math.round((sums[k] / n) * 10000) / 10000]));
  out[label(run.config)] = { run_id: run.id, scored: n, summary, per_query: per };
  console.log(label(run.config).padEnd(36), metricsNames.map((k) => `${k} ${summary[k].toFixed(3)}`).join('  '));
}
if (outPath) fs.writeFileSync(outPath, JSON.stringify(out));
