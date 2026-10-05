// wf.api.listings_analyze > "Accepted": 202 with the job to poll.
const gw = $('Job input').first().json.gw;
const row = $('Create job').first().json;
return [{ json: { ok: true, gw, status: 202, data: { job_id: row.id, type: row.type, status: row.status, status_url: `/v1/jobs/${row.id}` } } }];
