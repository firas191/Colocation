// wf.match.tool_search > "Profile input": the agent's request goes through P2 (wf.profile.extract), like a search
// typed by the user, so the same checks apply (allowed preferences, currencies, geocoding).
const s = $('Start').first().json;
return [{ json: { text: String(s.request || '').slice(0, 2000), jurisdiction: s.jurisdiction, today: s.today } }];
