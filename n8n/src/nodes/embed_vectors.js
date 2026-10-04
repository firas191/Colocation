// wf.listings.embed > "Vectors": Ollama answer -> rows for app.store_listing_embeddings.
const batch = $('Loop batches').first().json;
let b = $input.first().json;
b = b.body !== undefined ? b.body : b;
if (typeof b === 'string') b = JSON.parse(b);
const v = b.embeddings || [];
if (v.length !== batch.ids.length) throw new Error(`embedding answer has ${v.length} vectors for ${batch.ids.length} texts`);
for (const x of v) if (!Array.isArray(x) || x.length !== 1024) throw new Error('embedding is not 1024 numbers');
return [{ json: { params: [batch.model, JSON.stringify(batch.ids.map((id, i) => ({ id, v: `[${v[i].join(',')}]` })))] } }];
