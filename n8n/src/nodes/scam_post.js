// wf.scam.check > "Score"
// Deterministic part: price, profile, price_mismatch and contact reuse signals, the detector's quoted signals (checked
// against the text), score and level from the scam.* settings. The agent's tools and note are kept as evidence for the
// moderator. A model or agent failure does not stop the check: the rules still apply.
/* @include lib/scam_signals.js */
const r = $input.first().json;
const g = $('Agent output').first().json;
const c = $('Context').first().json.ctx;
if (!c || c.ok === false) {
  return [{ json: { ok: false, store: false, listing_id: (c && c.listing_id) || null, transient: false,
    error: `context: ${(c && c.error_code) || 'no answer'}`, steps: [] } }];
}
const out = r.ok ? r.output : null;
const res = scamScore(c, out, { contact_reuse: g.contact_reuse });
const steps = [
  { agent: 'A4_scam_agent', prompt_version_id: g.agent_prompt_version_id, model: g.agent_model,
    input: { chars: Array.from(String(c.text || '')).length, jurisdiction: c.jurisdiction_code },
    output: { note: !!g.note, contact_reuse: (g.contact_reuse || []).length }, tool_calls: (g.tool_calls || []).map((t) => ({ tool: t })),
    latency_ms: g.agent_latency_ms || 0, tokens_in: 0, tokens_out: 0, error: g.agent_ok ? null : g.agent_error },
  { agent: 'A4_scam_detector', prompt_version_id: r.prompt_version_id || null, model: r.model || null,
    input: { chars: Array.from(String(c.text || '')).length },
    output: r.ok ? { signals: res.signals.length, dropped: res.dropped.length, score: res.score } : { error_code: r.error_code },
    latency_ms: r.latency_ms || 0, tokens_in: r.tokens_in || 0, tokens_out: r.tokens_out || 0,
    error: r.ok ? null : `${r.error_code}${r.detail ? ': ' + String(r.detail).slice(0, 200) : ''}` }];
const detail = { prompt_version_id: r.prompt_version_id || null, model: r.model || null, model_ok: !!r.ok,
  agent: { ok: !!g.agent_ok, prompt_version_id: g.agent_prompt_version_id, tool_calls: g.tool_calls || [], error: g.agent_error || null },
  note: g.note || null, contact_reuse: g.contact_reuse || [],
  dropped: res.dropped, prices_in_text: out ? out.prices_in_text : null, market: c.market };
return [{ json: { ok: true, store: true, listing_id: c.listing_id, steps,
  params: [c.listing_id, JSON.stringify({ score: res.score, level: res.level, signals: res.signals, detail })],
  summary: { score: res.score, level: res.level, signals: res.signals.map((s) => s.type), model_ok: !!r.ok,
    agent_ok: !!g.agent_ok, tool_calls: g.tool_calls || [], note: g.note || null } } }];
