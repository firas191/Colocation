// wf.eval.retrieval > "Plan"
// Input: job row, dataset, queries with gold resolved against the current
// documents (eval.resolve_gold), embedding models and settings.
// Fails the job (throws) when the dataset is missing or a gold span cannot be
// located: numbers computed on a broken gold set would be wrong, not partial.
const row = $input.first().json;
if (!row.job_id) throw new Error('job not found or already finished');
if (!row.dataset_id) throw new Error(`dataset ${row.input.dataset} v${row.input.version} not found`);
const queries = row.queries || [];
if (!queries.length) throw new Error('dataset has no queries');
const problems = [];
for (const q of queries) {
  for (const g of q.gold || []) {
    if (!g.found) problems.push(`${q.external_id}: gold not found in ${g.source_key}`);
    else if (g.ambiguous) problems.push(`${q.external_id}: gold start quote occurs more than once in ${g.source_key}`);
  }
}
if (problems.length) throw new Error('gold set does not match the corpus: ' + problems.slice(0, 10).join('; ') + (problems.length > 10 ? ` (+${problems.length - 10})` : ''));

const configs = row.input.configs;
const cfg = {};
for (const [k, v] of Object.entries(row.cfg || {})) cfg[k] = v;
const models = (row.models || []).filter((m) => configs.some((c) => c.model === m.name && c.mode !== 'lexical'));
const out = [];
for (const m of models) {
  const size = m.endpoint === 'tei' ? Number(cfg['kb.batch_e5'] || 16) : Number(cfg['kb.batch_bge'] || 32);
  for (let i = 0; i < queries.length; i += size) {
    const b = queries.slice(i, i + size);
    const inputs = b.map((q) => (m.query_prefix || '') + q.query);
    const req = m.endpoint === 'tei'
      ? { url: `${cfg['kb.tei_base_url']}/embed`, body: { inputs, normalize: true, truncate: true } }
      : { url: `${cfg['ollama.base_url']}/api/embed`, body: { model: m.name, input: inputs, truncate: true } };
    out.push({ json: { model: m.name, endpoint: m.endpoint, dims: m.dims, query_ids: b.map((q) => q.id), ...req } });
  }
}
// A purely lexical matrix needs no embeddings: one placeholder item keeps the flow going.
if (!out.length) out.push({ json: { model: null, query_ids: [], url: null, body: null, none: true } });
out[0].json.t_embed_start = Date.now();
return out;
