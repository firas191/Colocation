// wf.listings.embed > "Summarize"
const start = $('Start job').first().json;
const n = (start.listings || []).length;
return [{ json: { job_id: start.job_id, status: 'succeeded', error: null, output: { listings_embedded: n } } }];
