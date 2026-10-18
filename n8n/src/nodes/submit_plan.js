// wf.api.listings_submit > "Next steps": the answer of app.listing_submit, and whether the newly published listing
// must be embedded now (the same text as app.listings_to_embed). A failed embedding leaves it published without a
// vector: the word search still finds it and the embed job fills it later (D-083).
const r = ($input.first().json || {}).r || null;
const cfg = (r && r.embed) || {};
const embed = !!(r && r.status === 200 && r.embed_text);
return [{ json: { r, embed, model: cfg['ollama.embed_model'] || 'bge-m3',
  embed_url: `${String(cfg['ollama.base_url'] || '').replace(/\/+$/, '')}/api/embed`,
  embed_body: { model: cfg['ollama.embed_model'] || 'bge-m3', input: [(r && r.embed_text) || ''], truncate: true,
                keep_alive: cfg['llm.keep_alive'] || '10m' } } }];
