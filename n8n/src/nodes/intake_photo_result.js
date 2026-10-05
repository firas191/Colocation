// wf.intake.photos > "Result": one line per upload for the job output.
const o = $('Outcome').first().json;
const ran = (name) => { try { return $(name).first().json; } catch (e) { return null; } };   // node not on this path
if (o.action === 'store') {
  const r = (ran('Store photo') || {}).r || {};
  if (r.ok) {
    const rep = o.report;
    const v = ran('Check photo');
    return [{ json: { upload_id: o.upload_id, key: o.key, status: 'processed', media_id: r.media_id,
      near_duplicates: r.near_duplicates || [], blur: rep.blur.counts, sharpness: rep.metrics.sharpness,
      has_gps: !!(rep.exif && rep.exif.has_gps), ms: rep.timings && rep.timings.total_ms,
      vision: v ? { status: v.analysis.status, room_type: v.analysis.fields ? v.analysis.fields.room_type : null,
        flags: v.analysis.flags || [], error_code: v.analysis.error_code || null } : { status: 'skipped' } } }];
  }
  return [{ json: { upload_id: o.upload_id, key: o.key, status: 'rejected', error_code: r.error_code || 'STORE_FAILED' } }];
}
if (o.action === 'reject') return [{ json: { upload_id: o.upload_id, key: o.key, status: 'rejected', error_code: o.code } }];
if (o.action === 'missing') return [{ json: { upload_id: o.upload_id, key: o.key, status: 'missing' } }];
return [{ json: { upload_id: o.upload_id, key: o.key, status: 'transient', error_code: o.code, error: o.message } }];
