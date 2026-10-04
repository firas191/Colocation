// wf.api.search > "Search input"
// Explicit query parameters win; with use_profile=true, missing ones come from the saved profile.
const v = $('Validate query').first().json;
const prof = $input.first().json.profile || null;
const i = { ...v.input };
const used = [];
if (prof) {
  if (!i.jurisdiction && prof.jurisdiction_code) { i.jurisdiction = prof.jurisdiction_code; used.push('jurisdiction'); }
  if (i.max_rent_minor === null && prof.budget_max_minor !== null) {
    i.max_rent_minor = prof.budget_max_minor; i.currency = prof.currency; i.budget_period = prof.budget_period; used.push('budget');
  }
  if (i.lat === null && !i.place && prof.lat !== null && prof.lng !== null) {
    i.lat = prof.lat; i.lng = prof.lng; if (i.radius_m === null) i.radius_m = prof.radius_m; used.push('anchor');
  }
}
if (!i.jurisdiction) i.jurisdiction = i.account_jurisdiction;
delete i.account_jurisdiction;
return [{ json: { ...i, profile_fields_used: used, no_jurisdiction: !i.jurisdiction } }];
