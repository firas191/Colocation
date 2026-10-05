// wf.listing.analyze > "Embedding rows": Ollama answer -> rows for app.store_listing_embeddings. A failed embedding
// leaves the listing published without a vector: the text search still finds it, and the embed job fills it later.
const q = $('Embedding request').first().json;
const res = $input.first().json || {};
let b = res.body !== undefined ? res.body : res;
if (typeof b === 'string') { try { b = JSON.parse(b); } catch (e) { b = {}; } }
const v = (b && b.embeddings && b.embeddings[0]) || null;
if (!Array.isArray(v) || v.length !== 1024) return [{ json: { skip: true, error: `embedding: ${res.statusCode || 'no answer'}` } }];
return [{ json: { skip: false, params: [q.model, JSON.stringify([{ id: q.listing_id, v: `[${v.join(',')}]` }])] } }];
