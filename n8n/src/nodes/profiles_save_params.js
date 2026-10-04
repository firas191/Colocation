// wf.api.profiles_extract > "Save input": the extracted profile in the shape app.save_profile takes.
const v = $('Validate body').first().json;
const x = $input.first().json;
const p = x.profile;
const a = x.anchor && x.anchor.status === 'found' ? x.anchor.place : null;
const body = { ...p, jurisdiction_code: x.search_jurisdiction, anchor_lat: a ? a.lat : null, anchor_lng: a ? a.lng : null,
  extraction: { prompt_version_id: x.steps[0].prompt_version_id, model: x.steps[0].model, warnings: x.warnings } };
return [{ json: { params: [v.gw.ctx.user_id, JSON.stringify(body)] } }];
