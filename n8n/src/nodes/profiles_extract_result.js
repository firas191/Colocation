// wf.api.profiles_extract > "Build result" (and after "Save profile")
const v = $('Validate body').first().json;
const x = $('Extract').first().json;
if (!x.ok) {
  const status = x.error_code === 'UPSTREAM_UNAVAILABLE' ? 503 : 422;
  return [{ json: { ok: false, gw: v.gw, status, steps: x.steps,
    error: { code: x.error_code, message: x.error_code === 'UPSTREAM_UNAVAILABLE' ? 'The language model is unavailable'
      : 'The request could not be turned into a profile', details: [] }, log: { reason: 'profile_extraction', detail: x.error_code } } }];
}
let saved = null;
if (v.save) {
  const s = $input.first().json;
  if (s.error) {
    return [{ json: { ok: false, gw: v.gw, status: 422, steps: x.steps, error: { code: 'VALIDATION_FAILED', message: 'Profile could not be saved',
      details: [{ field: 'profile', issue: 'rejected_by_database' }] }, log: { reason: 'save_profile', detail: String(s.error.message || s.error).slice(0, 200) } } }];
  }
  saved = s.saved || null;
}
return [{ json: { ok: true, gw: v.gw, status: 200, steps: x.steps,
  data: { profile: x.profile, search_jurisdiction: x.search_jurisdiction, anchor: x.anchor, warnings: x.warnings, saved } } }];
