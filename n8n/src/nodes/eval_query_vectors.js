// wf.eval.retrieval > "Query vectors"
// Input: embedding answers for the query batches (text), in request order.
// Output: one item per configuration to evaluate, for the loop.
const plan = $('Start job').first().json;
const reqs = $('Plan').all().map((i) => i.json);
const t0 = reqs[0].t_embed_start;
const embedMs = Date.now() - t0;
const vectors = {};                       // model -> query_id -> vector
const perModelMs = {};
const answers = $input.all().map((i) => i.json.data);
reqs.forEach((req, i) => {
  if (req.none) return;
  const a = typeof answers[i] === 'string' ? JSON.parse(answers[i]) : answers[i];
  const vecs = req.endpoint === 'tei' ? a : a && a.embeddings;
  if (!Array.isArray(vecs) || vecs.length !== req.query_ids.length) throw new Error(`${req.model}: bad embedding answer for queries`);
  vectors[req.model] = vectors[req.model] || {};
  vecs.forEach((v, j) => {
    if (v.length !== req.dims) throw new Error(`${req.model}: dimension ${v.length}`);
    vectors[req.model][req.query_ids[j]] = v;
  });
});
const nModels = Object.keys(vectors).length || 1;
const nQueries = plan.queries.length;
// Embedding time is measured for all batches together; per query it is the
// average over models and queries (an amortised figure, D-040).
const embedMsPerQuery = embedMs / nModels / nQueries;
return plan.input.configs.map((c, i) => ({ json: {
  job_id: plan.job_id, dataset_id: plan.dataset_id, config_index: i,
  config: { ...c, jurisdiction: plan.input.jurisdiction, dataset: plan.input.dataset, version: plan.input.version,
            label: plan.input.label, overlap_fraction: Number((plan.cfg || {})['eval.relevance_overlap'] || 0.5) },
  git_sha: plan.input.git_sha, embed_ms_per_query: Math.round(embedMsPerQuery * 10) / 10,
  has_vectors: !!vectors[c.model],
} }));
