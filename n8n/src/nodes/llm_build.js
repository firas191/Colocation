// wf.llm.call > "Build request"
// Input: the caller's item {prompt, version?, model?, vars, meta?} merged with the row of
// "Load prompt" {prompt_row, cfg}. Output: the Ollama /api/chat request, or a final
// result (skip) when the prompt version does not exist.
/* @include lib/llm.js */
const call = $('Start').first().json;
const row = $input.first().json;
const s = row.cfg || {};
const cfg = {
  base_url: s['ollama.base_url'], default_model: s['llm.default_model'], num_ctx: s['llm.num_ctx'],
  keep_alive: s['llm.keep_alive'], seed: s['llm.seed'], model_overrides: s['llm.model_overrides'] || {},
};
const t0 = Date.now();
const base = { t0, meta: call.meta ?? null, prompt: call.prompt, timeout_ms: Number(s['llm.timeout_ms'] || 120000) };
const p = row.prompt_row;
if (!p) {
  return [{ json: { ...base, skip: true, result: { ok: false, error_code: 'prompt_not_found',
    detail: `${call.prompt} v${call.version ?? 'active'} not found`, attempts: 0 } } }];
}
let req;
try {
  req = buildRequest(p, call.vars || {}, cfg, call.model || null);
} catch (e) {
  return [{ json: { ...base, skip: true, result: { ok: false, error_code: 'template_error', detail: String(e.message).slice(0, 300),
    prompt_version_id: p.version_id, version: p.version, attempts: 0 } } }];
}
return [{ json: { ...base, skip: false, url: req.url, body: req.body, model: req.model,
  prompt_version_id: p.version_id, version: p.version, schema: p.output_schema } }];
