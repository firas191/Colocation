// wf.intake.photos > "Vision input": the wf.llm.call input for P7 on the stored (blurred, EXIF-free) copy (D-081).
const o = $('Outcome').first().json;
const s = $('Store photo').first().json;
return [{ json: { prompt: 'P7_photo_analyzer', vars: {}, image: { key: o.report.output.key },
  meta: { media_id: s.r.media_id, upload_id: o.upload_id } } }];
