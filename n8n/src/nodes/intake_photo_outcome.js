// wf.intake.photos > "Outcome": what the Media service answered.
//   200 -> store; 422 -> reject (the reason code from the service); 404 -> not uploaded yet (left pending);
//   anything else (503, timeout, connection refused) -> transient: the job is retried later (spec 5.6).
const req = $('Request').first().json;
const r = $input.first().json || {};
const status = r.statusCode || 0;
let body = r.body;
if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = null; } }
const base = { upload_id: req.upload_id, key: req.key };
if (status === 200 && body && body.sha256) return [{ json: { ...base, action: 'store', report: body } }];
if (status === 422) {
  const issue = (body && body.error && body.error.details && body.error.details[0] && body.error.details[0].issue) || 'INVALID';
  return [{ json: { ...base, action: 'reject', code: issue, message: (body && body.error && body.error.message) || 'rejected by the media service' } }];
}
if (status === 404) return [{ json: { ...base, action: 'missing' } }];
return [{ json: { ...base, action: 'transient', code: 'MEDIA_SERVICE', message: `media service answered ${status || r.code || 'nothing'}` } }];
