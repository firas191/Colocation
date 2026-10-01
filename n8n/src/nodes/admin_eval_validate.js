// wf.api.admin_eval_runs_create > "Validate body"
// POST /v1/admin/eval/runs  (role admin)
// Body: {dataset (required), version (default 1), jurisdiction (required), k (default 10, max 50),
//        configs: [{strategy, model, mode, candidates?, rrf_k?}] (default: full matrix of
//        both strategies x both models x dense|lexical|hybrid), git_sha, label}
const gw = $input.first().json;
const b = gw.ctx.body;
const details = [];
if (b === null || typeof b !== 'object' || Array.isArray(b)) {
  return [{ json: { ok: false, status: 422, gw, error: { code: 'VALIDATION_FAILED', message: 'Request body must be a JSON object', details: [] } } }];
}
const allowed = ['dataset', 'version', 'jurisdiction', 'k', 'configs', 'git_sha', 'label'];
for (const key of Object.keys(b)) if (!allowed.includes(key)) details.push({ field: key, issue: 'unknown_field' });
if (typeof b.dataset !== 'string' || !/^[a-z0-9_]{3,60}$/.test(b.dataset)) details.push({ field: 'dataset', issue: 'invalid_format' });
const version = b.version === undefined ? 1 : b.version;
if (!Number.isInteger(version) || version < 1) details.push({ field: 'version', issue: 'must_be_positive_integer' });
if (typeof b.jurisdiction !== 'string' || !/^[A-Z]{2}(-[A-Z0-9]{1,3})?$/.test(b.jurisdiction)) details.push({ field: 'jurisdiction', issue: 'invalid_format' });
const k = b.k === undefined ? 10 : b.k;
if (!Number.isInteger(k) || k < 1 || k > 50) details.push({ field: 'k', issue: 'must_be_integer_1_50' });
for (const f of ['git_sha', 'label']) {
  if (b[f] !== undefined && (typeof b[f] !== 'string' || b[f].length > 80 || !/^[\w.:/ -]*$/.test(b[f]))) details.push({ field: f, issue: 'invalid_format' });
}
const STRATEGIES = ['fixed_500_50', 'structure_aware_v1'];
const MODELS = ['bge-m3', 'multilingual-e5-large'];
const MODES = ['dense', 'lexical', 'hybrid'];
let configs = [];
if (b.configs === undefined) {
  for (const strategy of STRATEGIES) for (const model of MODELS) for (const mode of MODES) configs.push({ strategy, model, mode });
} else if (!Array.isArray(b.configs) || b.configs.length < 1 || b.configs.length > 48) {
  details.push({ field: 'configs', issue: 'must_be_array_1_48' });
} else {
  b.configs.forEach((c, i) => {
    if (!c || typeof c !== 'object') { details.push({ field: `configs[${i}]`, issue: 'must_be_object' }); return; }
    for (const key of Object.keys(c)) if (!['strategy', 'model', 'mode', 'candidates', 'rrf_k'].includes(key)) details.push({ field: `configs[${i}].${key}`, issue: 'unknown_field' });
    if (!STRATEGIES.includes(c.strategy)) details.push({ field: `configs[${i}].strategy`, issue: 'unknown' });
    if (!MODELS.includes(c.model)) details.push({ field: `configs[${i}].model`, issue: 'unknown' });
    if (!MODES.includes(c.mode)) details.push({ field: `configs[${i}].mode`, issue: 'unknown' });
    for (const f of ['candidates', 'rrf_k']) {
      if (c[f] !== undefined && (!Number.isInteger(c[f]) || c[f] < 1 || c[f] > 500)) details.push({ field: `configs[${i}].${f}`, issue: 'must_be_integer_1_500' });
    }
    configs.push({ strategy: c.strategy, model: c.model, mode: c.mode, candidates: c.candidates, rrf_k: c.rrf_k });
  });
}
if (details.length) {
  return [{ json: { ok: false, status: 422, gw, error: { code: 'VALIDATION_FAILED', message: 'Request body is invalid', details } } }];
}
configs = configs.map((c) => ({ ...c, candidates: c.candidates || 50, rrf_k: c.rrf_k || 60, k, rerank: false }));
const input = { dataset: b.dataset, version, jurisdiction: b.jurisdiction, k, configs, git_sha: b.git_sha || null, label: b.label || null };
const idem = gw.idempotency ? `${gw.idempotency.scope}:${gw.idempotency.key}` : null;
return [{ json: { ok: true, gw, params: [JSON.stringify(input), gw.ctx.user_id, idem, 'eval_retrieval'] } }];
