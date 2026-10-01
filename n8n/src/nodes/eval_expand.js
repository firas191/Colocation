// wf.eval.retrieval > "Expand queries"
// Input: the eval.runs row just created for one configuration.
// Output: one search request per query (eval.timed_search input).
const run = $input.first().json;
const plan = $('Start job').first().json;
const loopItem = $('Loop configs').first().json;
const c = loopItem.config;
// vectors are rebuilt from the embedding answers kept on "Query vectors"' input
const reqs = $('Plan').all().map((i) => i.json);
let answers = [];
try { answers = $('Embed queries').all().map((i) => i.json.data); } catch (e) { answers = []; }   // lexical-only matrix: never ran
const vec = {};
reqs.forEach((req, i) => {
  if (req.none || req.model !== c.model || answers[i] === undefined) return;
  const a = typeof answers[i] === 'string' ? JSON.parse(answers[i]) : answers[i];
  const vecs = req.endpoint === 'tei' ? a : a.embeddings;
  vecs.forEach((v, j) => { vec[req.query_ids[j]] = v; });
});
return plan.queries.map((q) => ({ json: { p: JSON.stringify({
  run_id: run.id, query_id: q.id, model: c.model, strategy: c.strategy, mode: c.mode, k: c.k,
  candidates: c.candidates, rrf_k: c.rrf_k, jurisdiction: c.jurisdiction, q_text: q.query,
  q_vec: c.mode === 'lexical' ? null : (vec[q.id] ? '[' + vec[q.id].join(',') + ']' : null),
}) } }));
