// wf.orchestrator > "Router input" (P1, active version)
const v = $('Validate body').first().json;
return [{ json: { prompt: 'P1_router', version: null, model: null, vars: { message: v.text, user_jurisdiction: v.jurisdiction || 'unknown' } } }];
