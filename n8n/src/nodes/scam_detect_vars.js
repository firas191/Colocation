// wf.scam.check > "Detect input": the wf.llm.call input for P8_scam_detector (the evaluated single-call prompt) on the
// listing's title and description; it gives the quoted text signals and the amounts written.
const s = $('Start').first().json;
const c = $('Context').first().json.ctx;
return [{ json: { prompt: 'P8_scam_detector', version: s.version ?? null, model: s.model || null,
  vars: { message: c.text, jurisdiction: c.jurisdiction_code, today: new Date().toISOString().slice(0, 10) },
  meta: { listing_id: c.listing_id } } }];
