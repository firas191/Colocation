// wf.flatmate.tool > "Tool answer" (platform P12, D-115): the profile agent's tools. my_profile: what is known and what
// is missing (app.flatmate_onboarding_state). propose_profile: the values checked by code; nothing is saved here, the
// person confirms on the page (POST /v1/me/flatmate-profile/apply).
/* @include lib/flatmate_profile.js */
const s = $('Start').first().json;
const st = ($input.first().json || {}).st || null;
if (s.tool === 'my_profile') {
  if (!st) return [{ json: { error: 'no_user' } }];
  return [{ json: { lifestyle: st.lifestyle, budget: st.budget, languages: st.languages, profile: st.profile, missing: st.missing,
    currency: (st.user || {}).currency } }];
}
if (s.tool === 'propose_profile') {
  const c = checkProposal(s.values);
  return [{ json: { ok: c.errors.length === 0, values: c.values, errors: c.errors,
    next: 'Give a short recap and tell the person to check it and press Save on the page.' } }];
}
return [{ json: { error: 'unknown_tool' } }];
