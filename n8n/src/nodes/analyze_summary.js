// wf.listing.analyze > "Summarize": job output, the raw uploads to delete, and whether to retry.
// Raw uploads carry EXIF (GPS, device) and unblurred faces: they are deleted once a decision is stored
// (processed or rejected). Missing files stay pending; a transient failure retries the job (spec 5.6).
const s = $('Start job').first().json;
const results = $input.all().map((i) => i.json).filter((r) => r && r.upload_id);
const count = (st) => results.filter((r) => r.status === st).length;
const transient = count('transient');
const output = { listing_id: s.input.listing_id, processed: count('processed'), rejected: count('rejected'),
  missing: count('missing'), transient, files: results.map(({ key, ...r }) => r) };
const del = results.filter((r) => ['processed', 'rejected'].includes(r.status)).map((r) => r.key);
return [{ json: { job_id: s.job_id, output, delete_keys: del, transient,
  error: transient ? `${transient} file(s) not processed: ${results.find((r) => r.status === 'transient').error}` : null,
  delete_url: `${String(s.media_url).replace(/\/+$/, '')}/v1/storage/delete` } }];
