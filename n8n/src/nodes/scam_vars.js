// wf.scam.check > "Call input"
// Input: the listing's text and jurisdiction from app.scam_context.
// Output: the wf.llm.call input for P8 (active version unless the caller asks for one).
const s = $('Start').first().json;
const c = $('Context').first().json.ctx;
return [{ json: { prompt: 'P8_scam_detector', version: s.version ?? null, model: s.model || null,
  vars: { message: c.text, jurisdiction: c.jurisdiction_code, today: new Date().toISOString().slice(0, 10) },
  meta: { listing_id: c.listing_id } } }];