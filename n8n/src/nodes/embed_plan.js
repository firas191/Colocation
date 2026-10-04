// wf.listings.embed > "Batches"
// Listings without an embedding, in batches of 16 texts per Ollama request, sent one batch
// at a time (D-049: the HTTP node sends all its items at once).
const row = $input.first().json;
if (!row.job_id) throw new Error('job not found or already finished');
const cfg = row.cfg || {};
const todo = row.listings || [];
const model = cfg['ollama.embed_model'] || 'bge-m3';
const url = `${String(cfg['ollama.base_url'] || '').replace(/\/+$/, '')}/api/embed`;
const out = [];
for (let i = 0; i < todo.length; i += 16) {
  const b = todo.slice(i, i + 16);
  out.push({ json: { model, url, ids: b.map((x) => x.id), body: { model, input: b.map((x) => x.text), truncate: true } } });
}
if (!out.length) out.push({ json: { none: true, model, ids: [] } });
return out;
