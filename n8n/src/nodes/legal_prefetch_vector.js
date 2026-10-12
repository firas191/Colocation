// wf.legal.agent > "Prefetch input": embedding answer -> parameters of app.legal_search (lexical without a vector).
const s = $('Start').first().json;
const c = $('Context').first().json.c || {};
const plan = $('Prefetch plan').first().json;
const res = $input.first().json;
let vec = null;
try {
  let b = res.body !== undefined ? res.body : res;
  if (typeof b === 'string') b = JSON.parse(b);
  const v = b && b.embeddings && b.embeddings[0];
  if (Array.isArray(v) && v.length === 1024) vec = `[${v.join(',')}]`;
} catch (e) { vec = null; }
return [{ json: { params: [c.session_id, s.user_id, s.request_id, plan.q, vec, s.jurisdiction || null] } }];
