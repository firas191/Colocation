// wf.eval.prompts > "Score"
// Scores one model answer against the item's labels (eval/lib/prompt_metrics.js) and builds
// the eval.results row. The raw answer is kept (truncated) for the failure analysis.
// P2 v3 answers in main units; they are converted as in the profile workflow before scoring
// against the minor-unit labels (D-066). The model's own answer is kept as model_output.
// P3 answers and labels are both in main units; P3 is scored on the answer and on the answer after
// the post-validation checks (lib/listing_check.js, with the jurisdiction's rent ranges, D-076).
/* @include eval/lib/prompt_metrics.js */
/* @include lib/money.js */
/* @include lib/listing_check.js */
/* @include lib/photo_check.js */
const r = $input.first().json;
const it = r.meta;
const CANARY = 'RTR-CANARY-41c7';
let out = r.ok ? r.output : null;
const c = ($('Start job').first().json.contexts || {})[it.context.jurisdiction] || {};
let check = null;
if (out && it.prompt === 'P7_photo_analyzer') check = checkPhoto(out);
if (out && it.prompt === 'P2_profile_extractor') out = amountsToMinor(out, c.currencies || {}, c.default_currency || null);
if (out && it.prompt === 'P3_listing_extractor') check = checkListing(out, c.rent_ranges || {}, c.default_currency || null, it.message || '');
// P7 is scored on the model's answer (raw free text included, for the people check), D-082.
const metrics = it.prompt === 'P1_router'
  ? scoreP1(out, it.labels, { tags: it.tags, raw: r.raw, canary: CANARY })
  : it.prompt === 'P3_listing_extractor' ? scoreP3(out, check, it.labels, it.tags)
  : it.prompt === 'P7_photo_analyzer' ? scoreP7(out, it.labels, it.tags) : scoreP2(out, it.labels, it.tags);
metrics.call_error = !!r.call_error;
metrics.error_code = r.ok ? null : (r.error_code || null);
// PostgreSQL jsonb refuses the NUL character; model text is stored without it (F-048).
const clean = (x) => (x == null ? null : String(x).replace(/\u0000/g, ''));
const output = { output: out, checked: check ? check.fields : undefined, model_output: out !== (r.ok ? r.output : null) ? r.output : undefined, raw: r.raw ? clean(r.raw).slice(0, 4000) : null, error_code: r.error_code, detail: clean(r.detail),
  first_error: r.first_error || null, attempts: r.attempts, latency_ms: r.latency_ms, load_ms: r.load_ms,
  tokens_in: r.tokens_in, tokens_out: r.tokens_out, model: r.model, prompt_version_id: r.prompt_version_id,
  thinking_chars: r.thinking_chars || 0 };
return [{ json: { params: [it.run_id, it.query_id, JSON.stringify(output), JSON.stringify(metrics)] } }];
