// wf.profile.extract > "Result"
// Adds the geocoded anchor (app.geocode) to the checked profile.
const x = $('Check profile').first().json;
if (!x.ok) return [{ json: x }];
const g = $input.first().json.g || null;
const warnings = [...x.warnings];
let anchor = null;
if (g) {
  anchor = { status: g.status, place: g.place || null, candidates: g.status === 'ambiguous' ? g.candidates : [] };
  if (g.status !== 'found') warnings.push(`anchor_${g.status}`);
}
const steps = [...x.steps];
if (g) steps.push({ agent: 'A2_profile', model: null, input: { tool: 'app.geocode', jurisdiction: x.geo_jurisdiction },
  output: { status: g.status, place_key: g.place ? g.place.place_key : null }, tool_calls: [{ tool: 'app.geocode' }] });
return [{ json: { ok: true, profile: x.profile, search_jurisdiction: x.search_jurisdiction, anchor, warnings, steps } }];
