// LLM call helpers for wf.llm.call (spec 9.1, 9.6, 8.8). Prompt templates come from
// ai.prompt_versions: a "## system" section and a "## user" section, with {{name}}
// variables. Untrusted text (the person's message) goes inside <message> delimiters and
// cannot close them. Output is requested as JSON constrained by the version's schema
// (Ollama "format"), then parsed and validated again here; one retry with the errors.

function splitTemplate(t) {
  const m = /^##\s*system\s*$([\s\S]*?)^##\s*user\s*$([\s\S]*)$/m.exec(String(t || ''));
  if (!m) throw new Error('template must have a "## system" and a "## user" section');
  return { system: m[1].trim(), user: m[2].trim() };
}

// Text written by users must not be able to end the delimited block or open a new one.
function sanitizeUntrusted(s) {
  return String(s == null ? '' : s).replace(/<\s*\/?\s*message\s*>/gi, (x) => x.replace(/</g, '‹').replace(/>/g, '›'));
}

function render(text, vars) {
  return text.replace(/\{\{\s*([a-z_][a-z0-9_]*)\s*\}\}/gi, (_, k) => {
    if (!Object.prototype.hasOwnProperty.call(vars, k)) throw new Error(`template variable ${k} has no value`);
    const v = vars[k];
    if (v === null || v === undefined) return 'null';
    return typeof v === 'string' ? v : JSON.stringify(v);
  });
}

// prompt: {template, output_schema, params, model}; vars: template variables (message is
// sanitised here); cfg: {base_url, default_model, num_ctx, keep_alive, seed, timeout_ms,
// model_overrides: {model: {think: false, ...}}}; model: optional override; images: optional
// base64 JPEGs sent with the user message (Ollama "images", P7 photo analysis, D-081).
function buildRequest(prompt, vars, cfg, model, images) {
  const parts = splitTemplate(prompt.template);
  const v = { ...vars };
  if (v.message !== undefined) v.message = sanitizeUntrusted(v.message);
  const useModel = model || prompt.model || cfg.default_model;
  const params = prompt.params || {};
  const over = (cfg.model_overrides || {})[useModel] || {};
  const options = {
    temperature: params.temperature ?? 0,
    seed: params.seed ?? cfg.seed ?? 42,
    num_ctx: params.num_ctx ?? cfg.num_ctx ?? 4096,
  };
  if (params.num_predict) options.num_predict = params.num_predict;
  const body = {
    model: useModel,
    stream: false,
    keep_alive: cfg.keep_alive || '10m',
    options,
    messages: [{ role: 'system', content: render(parts.system, v) }, { role: 'user', content: render(parts.user, v) }],
  };
  if (images && images.length) body.messages[1].images = images;
  if (prompt.output_schema) body.format = prompt.output_schema;
  if (over.think !== undefined) body.think = over.think;
  return { url: `${String(cfg.base_url).replace(/\/+$/, '')}/api/chat`, body, model: useModel };
}

// Model text -> {ok, value, error_code, errors}. Code fences around the JSON are tolerated.
function parseOutput(content, schema, validate, describe) {
  let text = String(content == null ? '' : content).trim();
  const fence = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(text);
  if (fence) text = fence[1].trim();
  let value;
  try {
    value = JSON.parse(text);
  } catch (e) {
    return { ok: false, error_code: 'invalid_json', errors: [], detail: 'not valid JSON' };
  }
  if (schema) {
    const errors = validate(schema, value);
    if (errors.length) return { ok: false, value, error_code: 'schema', errors, detail: describe(errors) };
  }
  return { ok: true, value };
}

// Messages for the single retry (spec 8.8: retry once with the validation error appended).
function retryBody(body, badContent, detail) {
  return {
    ...body,
    messages: [...body.messages,
      { role: 'assistant', content: String(badContent == null ? '' : badContent).slice(0, 4000) },
      { role: 'user', content: `Your answer is not valid: ${detail}. Reply again with only the JSON object that follows the schema.` }],
  };
}

// Ollama /api/chat response (full HTTP response from the HTTP node) -> fields we keep.
function readResponse(res) {
  const status = res && (res.statusCode || res.status) || 0;
  let b = res && res.body !== undefined ? res.body : res;
  if (typeof b === 'string') { try { b = JSON.parse(b); } catch (e) { b = { error: b.slice(0, 300) }; } }
  b = b || {};
  return {
    http_status: status,
    content: b.message ? b.message.content : null,
    done_reason: b.done_reason || null,     // 'length' = the answer hit num_predict and was cut (F-058)
    // models that think by default put their reasoning here and may leave content empty (F-048)
    thinking_chars: b.message && typeof b.message.thinking === 'string' ? b.message.thinking.length : 0,
    error: b.error || (status && status >= 400 ? `HTTP ${status}` : null),
    tokens_in: b.prompt_eval_count || 0,
    tokens_out: b.eval_count || 0,
    total_ms: b.total_duration ? Math.round(b.total_duration / 1e6) : null,
    load_ms: b.load_duration ? Math.round(b.load_duration / 1e6) : null,
    eval_ms: b.eval_duration ? Math.round(b.eval_duration / 1e6) : null,
  };
}

if (typeof module !== 'undefined') module.exports = { splitTemplate, sanitizeUntrusted, render, buildRequest, parseOutput, retryBody, readResponse };
