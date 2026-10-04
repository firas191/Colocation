// wf.profile.extract > "Call input"
// Input: {text, jurisdiction (account), today, model?, version?} and the jurisdiction's
// extraction context (currencies and exponents, allowed preference filters).
const s = $('Start').first().json;
const c = $input.first().json.ctx || {};
return [{ json: { prompt: 'P2_profile_extractor', version: s.version ?? null, model: s.model || null,
  vars: { message: s.text, jurisdiction: s.jurisdiction, today: s.today, default_currency: c.default_currency,
          currency_exponents: c.currencies, allowed_preferences: c.allowed_preference_filters },
  meta: { jurisdiction: s.jurisdiction, ctx: c } } }];
