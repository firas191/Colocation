// wf.match.search > "Query vector"
// Embedding answer -> search parameters. If the embedding fails the search still runs on
// its lexical side, with the warning code embedding_unavailable (spec 8.8: degrade, not fail).
const plan = $('Plan').first().json;
const res = $input.first().json;
let vec = null, warning = null;
const t1 = Date.now();
try {
  let b = res.body !== undefined ? res.body : res;
  if (typeof b === 'string') b = JSON.parse(b);
  const v = b && b.embeddings && b.embeddings[0];
  if (Array.isArray(v) && v.length === 1024) vec = `[${v.join(',')}]`;
  else warning = 'embedding_unavailable';
} catch (e) { warning = 'embedding_unavailable'; }
return [{ json: { params: [JSON.stringify({ ...plan.p, q_vec: vec })], embed_ms: t1 - plan.t0, warning } }];
