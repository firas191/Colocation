// wf.api.search_v2 > "Query vector": embedding answer -> search parameters. Without an embedding the search still
// runs on its word side, with the warning embedding_unavailable (spec 8.8: degrade, not fail), as in v1.
const plan = $('Search input').first().json;
const res = $input.first().json;
let vec = null, warning = null;
try {
  let b = res.body !== undefined ? res.body : res;
  if (typeof b === 'string') b = JSON.parse(b);
  const v = b && b.embeddings && b.embeddings[0];
  if (Array.isArray(v) && v.length === 1024) vec = `[${v.join(',')}]`;
  else warning = 'embedding_unavailable';
} catch (e) { warning = 'embedding_unavailable'; }
return [{ json: { params: [JSON.stringify({ ...plan.p, q_vec: vec })], embed_ms: Date.now() - plan.t0, warning } }];
