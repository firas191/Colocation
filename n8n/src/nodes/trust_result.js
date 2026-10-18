// wf.trust.assess > "Result": what the submit needs (the stored report) and the trace step.
const c = $('Check answer').first().json;
const r = ($input.first().json || {}).r || null;
if (!r || !r.report_id) return [{ json: { ok: false, error_code: 'store_failed', steps: [c.step] } }];
return [{ json: { ok: true, report_id: r.report_id, score: r.score, verdict: r.verdict, hard: r.hard, flags: r.flags,
  signals: (r.signals || []).map((x) => x.signal), agent: r.agent, steps: [c.step] } }];
