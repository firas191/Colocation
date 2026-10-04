// wf.llm.call > "Check output" (attempt 1) and "Check retry" (attempt 2)
// Reads the Ollama answer, parses the JSON and validates it against the version's schema.
// After a failed first attempt (invalid JSON or schema) asks for one retry with the errors
// (spec 8.8); a transport error (timeout, Ollama down, unknown model) is not retried.
/* @include lib/schema_lite.js */
/* @include lib/llm.js */
const ATTEMPT = __ATTEMPT__;
const b = $('Build request').first().json;
const prev = ATTEMPT === 1 ? null : $('Check output').first().json;
const resIn = $input.first().json;
const r = resIn.error && !resIn.statusCode ? { http_status: 0, content: null, error: String(resIn.error.message || resIn.error).slice(0, 300),
  tokens_in: 0, tokens_out: 0, total_ms: null, load_ms: null } : readResponse(resIn);
const tokens_in = r.tokens_in + (prev ? prev.tokens_in : 0);
const tokens_out = r.tokens_out + (prev ? prev.tokens_out : 0);
const load_ms = (r.load_ms || 0) + (prev ? prev.load_ms || 0 : 0);
const common = { meta: b.meta, prompt: b.prompt, prompt_version_id: b.prompt_version_id, version: b.version, model: b.model,
  attempts: ATTEMPT, tokens_in, tokens_out, load_ms, latency_ms: Date.now() - b.t0, thinking_chars: r.thinking_chars || 0 };
if (r.error || r.content == null) {
  return [{ json: { retry: false, tokens_in, tokens_out, load_ms, result: { ...common, ok: false, error_code: 'call_failed',
    detail: r.error || 'empty answer', call_error: true, raw: null, output: null } } }];
}
const parsed = (!String(r.content).trim() && r.thinking_chars)
  ? { ok: false, error_code: 'thinking_only', detail: `empty answer after ${r.thinking_chars} characters of thinking` }
  : parseOutput(r.content, b.schema, validate, describe);
if (parsed.ok) {
  return [{ json: { retry: false, tokens_in, tokens_out, load_ms, result: { ...common, ok: true, output: parsed.value, raw: r.content } } }];
}
if (ATTEMPT === 1) {
  return [{ json: { retry: true, tokens_in, tokens_out, load_ms, url: b.url, body: retryBody(b.body, r.content, parsed.detail || parsed.error_code),
    first: { error_code: parsed.error_code, detail: parsed.detail, raw: r.content } } }];
}
return [{ json: { retry: false, tokens_in, tokens_out, load_ms, result: { ...common, ok: false, error_code: parsed.error_code,
  detail: parsed.detail || null, raw: r.content, output: null, first_error: prev.first } } }];
