// wf.api.health > "Summarize"
// Every dependency check ran with "continue on error"; an item with `error`
// means the dependency did not answer correctly within the timeout.
const c = $('Health config').first().json;
const ollamaOut = $('Check Ollama').first().json;
const s3Out = $('Check object storage').first().json;

const ollamaOk = !ollamaOut.error && Array.isArray(ollamaOut.models);
const names = ollamaOk ? ollamaOut.models.map((m) => String(m.name || m.model || '')) : [];
const modelPresent = names.some((n) => n === c.embed_model || n.startsWith(c.embed_model + ':'));
const s3Ok = !s3Out.error;

const checks = {
  database: c.db,
  object_storage: { ok: s3Ok, ...(s3Ok ? {} : { detail: 'no healthy answer from storage' }) },
  ollama: { ok: ollamaOk && modelPresent, reachable: ollamaOk, embed_model: c.embed_model, embed_model_present: modelPresent,
            ...(ollamaOk ? {} : { detail: 'no answer from Ollama' }) },
};
const allOk = Object.values(checks).every((x) => x.ok);
return [{ json: { ok: true, gw: c.gw, status: allOk ? 200 : 503,
  data: { status: allOk ? 'ok' : 'degraded', checks } } }];
