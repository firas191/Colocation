// wf.api.listings_submit_v2 > "Next steps": app.listing_submit_job's answer (202 job, or the v1 answers), and whether
// a listing published here (trust.enabled off) must be embedded now, as in the v1 submit.
const r = ($('Submit').first().json || {}).r || null;
const cfg = (r && r.embed) || {};
const embed = !!(r && r.status === 200 && r.embed_text);
return [{ json: { r, embed, model: cfg['ollama.embed_model'] || 'bge-m3',
  embed_url: `${String(cfg['ollama.base_url'] || '').replace(/\/+$/, '')}/api/embed`,
  embed_body: { model: cfg['ollama.embed_model'] || 'bge-m3', input: [(r && r.embed_text) || ''], truncate: true,
                keep_alive: cfg['llm.keep_alive'] || '10m' } } }];
