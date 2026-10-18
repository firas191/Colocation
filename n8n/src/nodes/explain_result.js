// wf.api.flatmate_explain > "Build result": the model's sentence if it passes the check (short, no number but the
// score, no topic that was not given), else the sentence written by code. source says which one the person reads.
/* @include lib/flatmate_profile.js */
const p = $('Plan').first().json;
if (p.done) return [{ json: { ok: false, gw: p.gw, status: p.status, error: p.error } }];
let m = null;
try { m = p.model ? ($('Explainer').first().json || null) : null; } catch (e) { m = null; }
const sentence = m && m.ok && m.output ? String(m.output.sentence || '').trim() : '';
const chk = sentence ? checkSentence(sentence, p.compat, p.lang) : { ok: false, why: p.model ? 'model_failed' : 'model_off' };
const steps = p.model ? [{ agent: 'P12_match_explainer', prompt_version_id: m && m.prompt_version_id || null, model: m && m.model || null,
  input: { factors: (p.compat.factors || []).length }, output: { kept: chk.ok, why: chk.why }, tool_calls: [],
  latency_ms: m && m.latency_ms || null, tokens_in: m && m.tokens_in || null, tokens_out: m && m.tokens_out || null,
  error: m && !m.ok ? String(m.error_code || 'failed') : null }] : [];
return [{ json: { ok: true, gw: p.gw, status: 200, steps, data: { score: p.compat.score ?? null, factors: p.compat.factors || [],
  sentence: chk.ok ? sentence : p.code, source: chk.ok ? 'model' : 'code' } } }];
