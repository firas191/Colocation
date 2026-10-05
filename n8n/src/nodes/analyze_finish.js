// wf.listing.analyze > "Finish input": parameters of app.job_finish.
// The job fails and is retried when a photo or the extraction hit a transient failure (model or
// service unavailable, spec 5.6). A non-transient extraction failure (invalid output twice) fails
// the job without retry; photos already stored stay stored and a new analysis repeats the extraction.
const x = $('Summarize').first().json;
const d = $('Delete raw uploads').first().json || {};
const e = $('Extract listing').first().json || {};
// Automatic publication (D-083, setting listing.auto_publish): its result, when it ran.
let pub = null;
try { pub = ($('Auto publish').first().json || {}).r || null; } catch (err) { pub = null; }
const output = { ...x.output, raw_deleted: x.delete_keys.length ? (d.statusCode === 200 ? x.delete_keys.length : 0) : 0,
  extraction: { status: e.status || 'failed', issues: e.issues || [], rent_scope: e.rent_scope ?? null, error: e.error || null },
  publication: pub ? { published: !!pub.published, reason: pub.reason || null, missing: pub.missing || [] } : null };
if (x.delete_keys.length && d.statusCode !== 200) output.raw_delete_error = `media service answered ${d.statusCode || 'nothing'}`;
const transient = !!x.transient || (e.ok === false && !!e.transient);
const errors = [x.error, e.ok === false ? e.error : null].filter(Boolean);
const failed = transient || e.ok === false;
return [{ json: { params: [x.job_id, failed ? 'failed' : 'succeeded', JSON.stringify(output), errors.join('; ') || null, transient] } }];
