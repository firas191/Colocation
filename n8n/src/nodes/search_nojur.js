// wf.api.search > "No jurisdiction": use_profile=true but neither the request nor a profile names one.
const v = $('Validate query').first().json;
return [{ json: { ok: false, gw: v.gw, status: 422, error: { code: 'VALIDATION_FAILED', message: 'Query parameters are invalid',
  details: [{ field: 'jurisdiction', issue: 'required' }] } } }];
