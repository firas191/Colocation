// wf.api.search_v2 > "No text": filters only, no embedding.
const plan = $('Search input').first().json;
return [{ json: { params: [JSON.stringify(plan.p)], embed_ms: 0, warning: null } }];
