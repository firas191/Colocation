// wf.llm.call > "Result" (every path ends here)
// {ok, output, raw, error_code, detail, prompt, prompt_version_id, version, model, attempts,
//  tokens_in, tokens_out, load_ms, latency_ms, call_error, meta}
const j = $input.first().json;
const r = j.result || {};
const b = $('Build request').first().json;
return [{ json: { ok: false, output: null, raw: null, error_code: null, detail: null, call_error: false,
  prompt: b.prompt, meta: b.meta, latency_ms: Date.now() - b.t0, tokens_in: 0, tokens_out: 0, ...r } }];
