// wf.trust.assess > "Check answer" (D-107)
// The agent's or the detector's answer (or none) -> the signals that may count, merged with the database and rule
// signals, and one trace step without listing text (D-062). app.trust_store then caps the points and computes the
// score and verdict. The detector (P8_scam_detector, D-114) is read with the same checks as the agent, and its
// amounts give price_mismatch.
/* @include lib/agent_check.js */
/* @include lib/trust_rules.js */
const a = $('Rules').first().json;
let r = {};
let d = null;
try { r = a.agent ? ($('Trust agent').first().json || {}) : {}; } catch (e) { r = {}; }
try { d = a.detector ? ($('Detector').first().json || {}) : null; } catch (e) { d = {}; }
const model = a.agent || a.detector;
const raw = a.agent ? (typeof r.output === 'string' ? r.output : '') : d && d.ok && d.output ? detectorAsAgent(d.output) : '';
const err = a.agent && r.error ? String(r.error.message || r.error).slice(0, 300)
  : a.detector && d && !d.ok ? String(d.error_code || 'detector_failed') + (d.detail ? `: ${String(d.detail).slice(0, 200)}` : '') : null;
const calls = a.agent ? toolCalls(r.intermediateSteps) : [];
const chk = model && raw ? checkAgent(raw, a.text, a.rules, a.detector ? 'detector' : 'agent') : { parsed: false, kept: [], dropped: [], summary: null };
if (a.detector && d && d.ok && d.output) {
  // the moderator's note: the detector's evidence lines of the signals that passed the checks only
  const keptQuotes = new Set(chk.kept.map((x) => x.quote));
  chk.summary = (d.output.signals || []).filter((x) => x && keptQuotes.has(String(x.quote || '').trim().slice(0, 160)))
    .map((x) => x.evidence).filter(Boolean).join('; ').slice(0, 300) || null;
}
const pm = a.detector && d && d.ok && d.output ? priceMismatch(a.rent, d.output.prices_in_text, a.text) : { signal: null, dropped: [] };
chk.dropped.push(...pm.dropped);
const signals = mergeSignals(a.db_signals, a.rules, pm.signal ? [...chk.kept, pm.signal] : chk.kept);
const agentState = !model ? (a.skip_reason || 'off') : err ? 'failed' : !raw ? 'no_answer' : !chk.parsed ? 'unparsed' : 'answered';
const step = { agent: a.detector ? 'A4_trust_detector' : 'A4_trust_agent',
  prompt_version_id: (a.detector ? d && d.prompt_version_id : a.prompt_version_id) || null,
  model: (a.detector ? d && d.model : a.model) || null,
  input: { chars: Array.from(a.text || '').length, rule_hits: a.rules.map((x) => x.signal), db_signals: a.db_signals.map((x) => x.signal) },
  output: { state: agentState, kept: [...chk.kept, ...(pm.signal ? [pm.signal] : [])].map((x) => ({ signal: x.signal, from: x.from || x.signal, points: x.points })),
            dropped: chk.dropped, raw_chars: Array.from(raw).length },
  tool_calls: calls.map((x) => ({ tool: x.tool })), latency_ms: Date.now() - a.t0,
  tokens_in: a.detector && d ? d.tokens_in || null : null, tokens_out: a.detector && d ? d.tokens_out || null : null,
  error: err || (model && !raw ? 'no_answer' : null) };
return [{ json: { listing_id: a.listing_id, step, payload: { signals, summary: chk.summary,
  prompt_version_id: model ? step.prompt_version_id : null, model: model ? step.model : null,
  agent: { state: agentState, tool_calls: calls.map((x) => x.tool), kept: chk.kept.length, dropped: chk.dropped.length } } } }];
