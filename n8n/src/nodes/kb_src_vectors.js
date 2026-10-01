// wf.kb.ingest_source > "Vectors"
// Input: embedding answers (text) in request order. Pairs vectors with chunk
// ids, checks count and dimension, and groups rows for the database (<= 200
// rows per statement).
const reqs = $('Embed batches').all().map((i) => i.json);
const answers = $input.all().map((i) => i.json.data);
if (answers.length !== reqs.length) throw new Error(`${answers.length} embedding answers for ${reqs.length} requests`);
const groups = new Map();
const timing = {};
reqs.forEach((req, i) => {
  const a = typeof answers[i] === 'string' ? JSON.parse(answers[i]) : answers[i];
  const vecs = req.endpoint === 'tei' ? a : a && a.embeddings;
  if (!Array.isArray(vecs) || vecs.length !== req.chunk_ids.length) {
    throw new Error(`${req.model}: expected ${req.chunk_ids.length} vectors, got ${Array.isArray(vecs) ? vecs.length : typeof vecs}`);
  }
  vecs.forEach((v, j) => {
    if (!Array.isArray(v) || v.length !== req.dims) throw new Error(`${req.model}: vector of dimension ${v && v.length}, expected ${req.dims}`);
    if (!groups.has(req.model)) groups.set(req.model, []);
    groups.get(req.model).push({ chunk_id: req.chunk_ids[j], embedding: v });
  });
});
const out = [];
for (const [model, rows] of groups) {
  for (let i = 0; i < rows.length; i += 200) out.push({ json: { model, rows: JSON.stringify(rows.slice(i, i + 200)) } });
}
return out;
