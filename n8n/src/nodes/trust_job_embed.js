// wf.listing.trust > "Embedding rows": Ollama answer -> rows for app.store_listing_embeddings.
const n = $('Next steps').first().json;
const res = $input.first().json || {};
let b = res.body !== undefined ? res.body : res;
if (typeof b === 'string') { try { b = JSON.parse(b); } catch (e) { b = {}; } }
const v = (b && b.embeddings && b.embeddings[0]) || null;
if (!Array.isArray(v) || v.length !== 1024) return [{ json: { skip: true } }];
return [{ json: { skip: false, params: [n.model, JSON.stringify([{ id: n.r.data.listing_id, v: `[${v.join(',')}]` }])] } }];
