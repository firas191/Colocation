// wf.api.admin_eval_prompt_runs_create > "Validate body"
// POST /v1/admin/eval/prompt-runs  (role admin)
// Body: {prompt (P1_router | P2_profile_extractor), versions: [int] (required), models: [string]
//        (default: llm.default_model), dataset (default: the prompt's golden set),
//        dataset_version (default 1), item_ids: [string] or limit (a subset, for smoke tests),
//        git_sha, label}
const gw = $input.first().json;
const b = gw.ctx.body;
const details = [];
const PROMPTS = { P1_router: 'p1_router', P2_profile_extractor: 'p2_profile' };
const allowed = ['prompt', 'versions', 'models', 'dataset', 'dataset_version', 'item_ids', 'limit', 'git_sha', 'label'];
for (const key of Object.keys(b)) if (!allowed.includes(key)) details.push({ field: key, issue: 'unknown_field' });
if (!Object.prototype.hasOwnProperty.call(PROMPTS, b.prompt)) details.push({ field: 'prompt', issue: 'unknown' });
if (!Array.isArray(b.versions) || b.versions.length < 1 || b.versions.length > 5 || !b.versions.every((v) => Number.isInteger(v) && v > 0)) {
  details.push({ field: 'versions', issue: 'must_be_array_of_1_to_5_positive_integers' });
}
if (b.models !== undefined && (!Array.isArray(b.models) || b.models.length < 1 || b.models.length > 5 ||
    !b.models.every((m) => typeof m === 'string' && /^[a-z0-9][a-z0-9._:-]{1,79}$/i.test(m)))) {
  details.push({ field: 'models', issue: 'must_be_array_of_1_to_5_model_names' });
}
if (b.dataset !== undefined && (typeof b.dataset !== 'string' || !/^[a-z0-9_]{3,60}$/.test(b.dataset))) details.push({ field: 'dataset', issue: 'invalid_format' });
const dv = b.dataset_version === undefined ? 1 : b.dataset_version;
if (!Number.isInteger(dv) || dv < 1) details.push({ field: 'dataset_version', issue: 'must_be_positive_integer' });
if (b.item_ids !== undefined && (!Array.isArray(b.item_ids) || b.item_ids.length > 500 || !b.item_ids.every((x) => typeof x === 'string' && /^[a-z0-9-]{1,40}$/.test(x)))) {
  details.push({ field: 'item_ids', issue: 'must_be_array_of_ids' });
}
if (b.limit !== undefined && (!Number.isInteger(b.limit) || b.limit < 1 || b.limit > 1000)) details.push({ field: 'limit', issue: 'must_be_integer_1_1000' });
for (const f of ['git_sha', 'label']) {
  if (b[f] !== undefined && (typeof b[f] !== 'string' || b[f].length > 80 || !/^[\w.:/ -]*$/.test(b[f]))) details.push({ field: f, issue: 'invalid_format' });
}
if (details.length) {
  return [{ json: { ok: false, status: 422, gw, error: { code: 'VALIDATION_FAILED', message: 'Request body is invalid', details } } }];
}
const input = { prompt: b.prompt, versions: [...new Set(b.versions)], models: b.models ? [...new Set(b.models)] : null,
  dataset: b.dataset || PROMPTS[b.prompt], dataset_version: dv, item_ids: b.item_ids || null, limit: b.limit || null,
  git_sha: b.git_sha || null, label: b.label || null };
const idem = gw.idempotency ? `${gw.idempotency.scope}:${gw.idempotency.key}` : null;
return [{ json: { ok: true, gw, params: [JSON.stringify(input), gw.ctx.user_id, idem, 'eval_prompts'] } }];
