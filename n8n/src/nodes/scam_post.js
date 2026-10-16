// wf.scam.check > "Score"
// Deterministic part after P8: price, profile and price_mismatch signals, the model's quoted signals (checked against
// the text), score and level from the scam.* settings. A model failure does not stop the check: rules still apply.
/* @include lib/scam_signals.js */
const r = $input.first().json;
const c = $('Context').first().json.ctx;
if (!c || c.ok === false) {
  return [{ json: { ok: false, store: false, listing_id: (c && c.listing_id) || null, transient: false,
    error: `context: ${(c && c.error_code) || 'no answer'}`, steps: [] } }];
}
const out = r.ok ? r.output : null;
const res = scamScore(c, out);
const step = { agent: 'A4_scam', prompt_version_id: r.prompt_version_id || null, model: r.model || null,
  input: { chars: Array.from(String(c.text || '')).length, jurisdiction: c.jurisdiction_code },
  output: r.ok ? { signals: res.signals.length, dropped: res.dropped.length, score: res.score } : { error_code: r.error_code },
  latency_ms: r.latency_ms || 0, tokens_in: r.tokens_in || 0, tokens_out: r.tokens_out || 0,
  error: r.ok ? null : `${r.error_code}${r.detail ? ': ' + String(r.detail).slice(0, 200) : ''}` };
const detail = { prompt_version_id: r.prompt_version_id || null, model: r.model || null, model_ok: !!r.ok,
  dropped: res.dropped, prices_in_text: out ? out.prices_in_text : null, market: c.market };
return [{ json: { ok: true, store: true, listing_id: c.listing_id, steps: [step],
  params: [c.listing_id, JSON.stringify({ score: res.score, level: res.level, signals: res.signals, detail })],
  summary: { score: res.score, level: res.level, signals: res.signals.map((s) => s.type), model_ok: !!r.ok } } }];