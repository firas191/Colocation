// wf.listing.apply > "Next steps": after the change is written, what is left to do outside the database: delete
// the removed photos from storage (Media service), embed the listing again when its place changed or it was just
// published (D-088).
const r = $input.first().json.r || {};
const ok = r.ok === true;
const keys = ok && Array.isArray(r.deleted_keys) ? r.deleted_keys : [];
const cfg = r.embed || {};
return [{ json: { r, delete: keys.length > 0, embed: ok && r.reembed === true && !!r.embed_text,
  delete_url: `${String(r.media_url || '').replace(/\/+$/, '')}/v1/storage/delete`, delete_body: { keys },
  model: cfg['ollama.embed_model'] || 'bge-m3',
  embed_url: `${String(cfg['ollama.base_url'] || '').replace(/\/+$/, '')}/api/embed`,
  embed_body: { model: cfg['ollama.embed_model'] || 'bge-m3', input: [r.embed_text || ''], truncate: true,
                keep_alive: cfg['llm.keep_alive'] || '10m' } } }];
