// wf.match.search > "No text": filters-only search, no embedding.
const plan = $input.first().json;
return [{ json: { params: [JSON.stringify(plan.p)], embed_ms: 0, warning: null } }];
