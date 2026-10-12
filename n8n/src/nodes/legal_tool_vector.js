// wf.legal.tool_search > "Search input": embedding answer -> parameters of app.legal_search. Without a vector (the
// embedding call failed) the search is lexical (spec 8.8: degrade, not fail).
const s = $('Start').first().json;
const plan = $('Plan').first().json;
const res = $input.first().json;
let vec = null;
try {
  let b = res.body !== undefined ? res.body : res;
  if (typeof b === 'string') b = JSON.parse(b);
  const v = b && b.embeddings && b.embeddings[0];
  if (Array.isArray(v) && v.length === 1024) vec = `[${v.join(',')}]`;
} catch (e) { vec = null; }
return [{ json: { params: [s.session_id, s.user_id, s.request_id, plan.q, vec, s.jurisdiction || null], embed_ms: Date.now() - plan.t0 } }];
