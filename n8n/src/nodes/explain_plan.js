// wf.api.flatmate_explain > "Plan" (platform P12, D-115): the score and factor states of social.compatibility for the
// pair (never the other person's answers). With the setting on and something known, one P12_match_explainer call
// writes the sentence; otherwise the sentence written by code is the answer.
/* @include lib/flatmate_profile.js */
const v = $('Validate').first().json;
const r = ($input.first().json || {}).r || null;
const gw = v.gw;
if (!r || r.error) {
  return [{ json: { model: false, done: true, ok: false, gw, status: r ? r.status : 500,
    error: r ? { ...r.error, details: r.error.details || [] } : { code: 'INTERNAL', message: 'Internal error', details: [] } } }];
}
const lang = ['fr', 'en', 'ar'].includes((v.input.body || {}).language) ? v.input.body.language : 'fr';
const c = r.data.compatibility || {};
const base = { gw, lang, compat: c, other: r.data.other, code: codeSentence(c, lang) };
if (!r.data.enabled || c.score === null || c.score === undefined) return [{ json: { ...base, model: false } }];
return [{ json: { ...base, model: true, llm: { prompt: 'P12_match_explainer', vars: { name: (r.data.other || {}).display_name || '-',
  score: String(c.score), factors: explainFactors(c, lang), language: { fr: 'French', en: 'English', ar: 'Arabic' }[lang] },
  meta: { user_id: gw.ctx.user_id } } } }];
