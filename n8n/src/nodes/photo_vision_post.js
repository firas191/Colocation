// wf.intake.photos > "Check photo": the P7 answer through the deterministic checks (lib/photo_check.js, D-081).
// A failed analysis does not reject the photo: it is stored as failed, and the listing gets the issue
// photo_analysis_failed for review (spec 8.4 A1 failure handling). The agent step keeps no image.
/* @include lib/photo_check.js */
const r = $input.first().json || {};
const v = $('Vision input').first().json;
const step = { agent: 'A1_photo', prompt_version_id: r.prompt_version_id || null, model: r.model || null,
  input: { media_id: v.meta.media_id, image: 'stored copy' },
  output: r.ok ? null : { error_code: r.error_code || 'call_failed' }, latency_ms: r.latency_ms || 0,
  tokens_in: r.tokens_in || 0, tokens_out: r.tokens_out || 0,
  error: r.ok ? null : `${r.error_code || 'call_failed'}${r.detail ? ': ' + String(r.detail).slice(0, 200) : ''}` };
let analysis;
if (r.ok && r.output) {
  const c = checkPhoto(r.output);
  analysis = { status: 'analyzed', prompt_version_id: r.prompt_version_id, version: r.version, model: r.model,
    fields: c.fields, issues: c.issues, field_confidence: c.field_confidence, flags: c.flags, dropped: c.dropped,
    model_output: c.dropped.length ? null : r.output, latency_ms: r.latency_ms, tokens_in: r.tokens_in, tokens_out: r.tokens_out };
  if (c.description !== null) analysis.description = c.description;
  step.output = { room_type: c.fields.room_type, flags: c.flags, dropped: c.dropped };
} else {
  analysis = { status: 'failed', prompt_version_id: r.prompt_version_id || null, model: r.model || null,
    error_code: r.error_code || 'call_failed', latency_ms: r.latency_ms || 0 };
}
return [{ json: { media_id: v.meta.media_id, analysis, steps: [step] } }];
