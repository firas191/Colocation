// wf.orchestrator > "Match input": search filters from the extracted profile.
const x = $input.first().json;
if (!x.ok) return [{ json: { skip: true, x } }];
const p = x.profile;
const a = x.anchor && x.anchor.status === 'found' ? x.anchor.place : null;
return [{ json: { skip: false, jurisdiction: x.search_jurisdiction, q: $('Validate body').first().json.text,
  max_rent_minor: p.budget_max_minor, currency: p.currency, budget_period: p.budget_period,
  lat: a ? a.lat : null, lng: a ? a.lng : null, place: null, radius_m: null, limit: 10 } }];
