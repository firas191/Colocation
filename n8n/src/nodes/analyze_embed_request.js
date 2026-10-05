// wf.listing.analyze > "Embedding request": the newly published listing's text for bge-m3 (the same text as
// app.listings_to_embed), so it is found by meaning at once (D-083).
const r = $input.first().json.r || {};
const cfg = r.embed || {};
return [{ json: { listing_id: $('Extract listing').first().json.listing_id, model: cfg['ollama.embed_model'] || 'bge-m3',
  url: `${String(cfg['ollama.base_url'] || '').replace(/\/+$/, '')}/api/embed`,
  body: { model: cfg['ollama.embed_model'] || 'bge-m3', input: [r.embed_text], truncate: true } } }];
