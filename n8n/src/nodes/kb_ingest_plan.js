// wf.kb.ingest > "Plan"
// Input: the job row with its input, the kb.* settings, the embedding models
// and the sources selected for this job (SQL "Start job").
// Output: one item per source for the loop, or one item {empty: true}.
const row = $input.first().json;
if (!row.job_id) return [{ json: { empty: true, job_id: null, reason: 'job_not_found_or_finished' } }];
const cfg = {};
for (const [k, v] of Object.entries(row.cfg || {})) cfg[k.replace(/^kb\./, '')] = v;
cfg.ollama_base_url = (row.cfg || {})['ollama.base_url'] || 'http://ollama:11434';
const wanted = cfg.embedding_models || ['bge-m3', 'multilingual-e5-large'];
const models = (row.models || []).filter((m) => wanted.includes(m.name));
const missing = wanted.filter((n) => !models.some((m) => m.name === n));
if (missing.length) return [{ json: { empty: true, job_id: row.job_id, reason: 'unknown_models: ' + missing.join(',') } }];
const sources = row.sources || [];
const requested = (row.input && row.input.sources) || [];
const unknown = requested.filter((k) => !sources.some((s) => s.source_key === k));
if (!sources.length) return [{ json: { empty: true, job_id: row.job_id, reason: 'no_sources', unknown_sources: unknown } }];
return sources.map((s) => ({ json: {
  job_id: row.job_id, force: !!(row.input && row.input.force), cfg, models,
  source: {
    id: s.id, source_key: s.source_key, url: s.url, language: s.language, cite_as: s.cite_as,
    jurisdiction_code: s.jurisdiction_code, fetch: s.fetch_config || {},
  },
  unknown_sources: unknown,
} }));
