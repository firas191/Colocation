// wf.profile.extract > "Check profile"
// Deterministic checks after P2 (spec 8.2 A2 guardrail, 4.4): preferences outside the
// jurisdiction's allowed list are moved to unparsed; a stated amount without a currency gets
// the jurisdiction's currency; an unknown currency or a reversed range is flagged. Warnings
// are codes, never sentences (spec 17.1). From P2 v3 the model gives amounts in main units and
// they are converted to minor units first (D-066, lib/money.js).
/* @include lib/money.js */
const r = $input.first().json;
const ctx = (r.meta && r.meta.ctx) || {};
const step = { agent: 'A2_profile', prompt_version_id: r.prompt_version_id || null, model: r.model || null,
  input: { chars: String($('Start').first().json.text || '').length, jurisdiction: r.meta && r.meta.jurisdiction },
  output: r.ok ? r.output : { error_code: r.error_code }, latency_ms: r.latency_ms, tokens_in: r.tokens_in || 0,
  tokens_out: r.tokens_out || 0, error: r.ok ? null : `${r.error_code}${r.detail ? ': ' + String(r.detail).slice(0, 200) : ''}` };
if (!r.ok) {
  return [{ json: { ok: false, error_code: r.call_error ? 'UPSTREAM_UNAVAILABLE' : 'EXTRACTION_FAILED', steps: [step], anchor_label: null } }];
}
const p = amountsToMinor(JSON.parse(JSON.stringify(r.output)), ctx.currencies || {}, ctx.default_currency || null);
const warnings = [];
const allowed = new Set((ctx.allowed_preference_filters || []).map(String));
for (const k of Object.keys(p.declared_preferences || {})) {
  if (!allowed.has(k)) {
    p.unparsed = [...(p.unparsed || []), `${k}: ${p.declared_preferences[k]}`];
    delete p.declared_preferences[k];
    warnings.push('preference_not_allowed');
  }
}
const currencies = ctx.currencies || {};
const hasAmount = p.budget_min_minor !== null || p.budget_max_minor !== null;
if (hasAmount && !p.currency) {
  p.currency = ctx.default_currency || null;
  warnings.push('currency_assumed');
}
if (p.currency && !Object.prototype.hasOwnProperty.call(currencies, p.currency)) {
  warnings.push('currency_unknown');
  p.budget_min_minor = null; p.budget_max_minor = null; p.currency = null; p.budget_period = null;
}
if (hasAmount && !p.budget_period) p.budget_period = 'month';
if (p.budget_min_minor !== null && p.budget_max_minor !== null && p.budget_min_minor > p.budget_max_minor) {
  [p.budget_min_minor, p.budget_max_minor] = [p.budget_max_minor, p.budget_min_minor];
  warnings.push('budget_range_reversed');
}
// The search runs in the jurisdiction the request names, else the account's.
const search_jurisdiction = p.jurisdiction_code || (r.meta && r.meta.jurisdiction) || null;
return [{ json: { ok: true, profile: p, search_jurisdiction, warnings, steps: [step],
  anchor_label: p.anchor_label || '', geo_jurisdiction: search_jurisdiction || '' } }];
