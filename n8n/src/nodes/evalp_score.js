// wf.eval.prompts > "Score"
// Scores one model answer against the item's labels (eval/lib/prompt_metrics.js) and builds
// the eval.results row. The raw answer is kept (truncated) for the failure analysis.
// P2 v3 answers in main units; they are converted as in the profile workflow before scoring
// against the minor-unit labels (D-066). The model's own answer is kept as model_output.
/* @include eval/lib/prompt_metrics.js */
/* @include lib/money.js */
const r = $input.first().json;
const it = r.meta;
const CANARY = 'RTR-CANARY-41c7';
let out = r.ok ? r.output : null;
if (out && it.prompt !== 'P1_router') {
  const c = ($('Start job').first().json.contexts || {})[it.context.jurisdiction] || {};
  out = amountsToMinor(out, c.currencies || {}, c.default_currency || null);
}
const metrics = it.prompt === 'P1_router'
  ? scoreP1(out, it.labels, { tags: it.tags, raw: r.raw, canary: CANARY })
  : scoreP2(out, it.labels, it.tags);
metrics.call_error = !!r.call_error;
// PostgreSQL jsonb refuses the NUL character; model text is stored without it (F-048).
const clean = (x) => (x == null ? null : String(x).replace(/\u0000/g, ''));
const output = { output: out, model_output: out !== (r.ok ? r.output : null) ? r.output : undefined, raw: r.raw ? clean(r.raw).slice(0, 4000) : null, error_code: r.error_code, detail: clean(r.detail),
  first_error: r.first_error || null, attempts: r.attempts, latency_ms: r.latency_ms, load_ms: r.load_ms,
  tokens_in: r.tokens_in, tokens_out: r.tokens_out, model: r.model, prompt_version_id: r.prompt_version_id,
  thinking_chars: r.thinking_chars || 0 };
return [{ json: { params: [it.run_id, it.query_id, JSON.stringify(output), JSON.stringify(metrics)] } }];
