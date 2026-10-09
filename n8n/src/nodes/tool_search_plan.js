// wf.match.tool_search > "Search plan": search filters from the profile P2 read in the agent's request.
const s = $('Start').first().json;
const x = $input.first().json;
if (!x.ok) return [{ json: { skip: true } }];
const p = x.profile;
const a = x.anchor && x.anchor.status === 'found' ? x.anchor.place : null;
return [{ json: { skip: false, jurisdiction: x.search_jurisdiction || s.jurisdiction, q: String(s.request || '').slice(0, 2000),
  max_rent_minor: p.budget_max_minor, currency: p.currency, budget_period: p.budget_period,
  lat: a ? a.lat : null, lng: a ? a.lng : null, place: null, radius_m: null, limit: 10 } }];
