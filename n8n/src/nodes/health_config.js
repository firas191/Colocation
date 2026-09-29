// wf.api.health > "Health config"
// Input: row from the database check. Passes the dependency URLs on.
const gw = $('Gateway').first().json;
const row = $input.first().json;
const cfg = row.cfg || {};
return [{ json: {
  gw,
  db: { ok: true, server_version: row.server_version, migration: row.migration, extensions: row.extensions },
  ollama_url: String(cfg['ollama.base_url'] || '').replace(/\/+$/, ''),
  embed_model: cfg['ollama.embed_model'] || 'bge-m3',
  s3_health_url: cfg['s3.health_url'] || '',
  timeout_ms: Number(cfg['health.timeout_ms'] || 3000),
} }];
