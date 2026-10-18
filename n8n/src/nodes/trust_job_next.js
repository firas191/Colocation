// wf.listing.trust > "Next steps": app.listing_submit's answer; a newly published listing is embedded at once for
// the search by meaning (as in the v1 submit; a failed embedding leaves it to the embed job, D-083).
const r = ($input.first().json || {}).r || null;
const cfg = (r && r.embed) || {};
const embed = !!(r && r.status === 200 && r.embed_text);
return [{ json: { r, embed, model: cfg['ollama.embed_model'] || 'bge-m3',
  embed_url: `${String(cfg['ollama.base_url'] || '').replace(/\/+$/, '')}/api/embed`,
  embed_body: { model: cfg['ollama.embed_model'] || 'bge-m3', input: [(r && r.embed_text) || ''], truncate: true,
                keep_alive: cfg['llm.keep_alive'] || '10m' } } }];
