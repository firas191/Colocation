// wf.fx.refresh > "Summarize"
const p = $('Parse rates').first().json;
const stored = $input.first().json.stored;
return [{ json: { job_id: p.job_id, status: 'succeeded', error: null,
  output: { as_of: p.as_of, published: p.published, stored, note: 'rates for currencies not in app.currencies are skipped' } } }];
