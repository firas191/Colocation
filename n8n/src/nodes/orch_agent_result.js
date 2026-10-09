// wf.orchestrator > "Agent answer": the Match agent's checked answer and the cards of its search.
const v = $('Validate body').first().json;
const d = $('Decide route').first().json;
const a = $input.first().json;
const o = d.router || {};
return [{ json: { ok: true, gw: v.gw, status: 200, steps: [...d.steps, ...a.steps],
  data: { intent: 'search_listings', language: o.language || d.detected_language || null, status: a.status, answer: a.answer,
          profile: a.profile, anchor: a.anchor, results: a.results, count: a.count,
          warnings: [...(d.followup ? ['followup'] : []), ...(a.warnings || [])],
          agent: a.agent, data_attribution: ['openstreetmap'] } } }];
