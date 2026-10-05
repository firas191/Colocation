// wf.listing.extract > "Call input"
// Input: the listing's text, jurisdiction and today's date there, and the Text service's answer.
// Output: the wf.llm.call input for P3 (active version unless the caller asks for one).
const s = $('Start').first().json;
const c = $('Context').first().json;
return [{ json: { prompt: 'P3_listing_extractor', version: s.version ?? null, model: s.model || null,
  vars: { message: c.text, jurisdiction: c.jurisdiction_code, today: c.today, default_currency: (c.ctx || {}).default_currency },
  meta: { listing_id: c.listing_id } } }];
