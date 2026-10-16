// wf.scam.check > "Result": {ok, status, listing_id, check_id, score, level, signals, model_ok, transient, error, steps}.
// status: checked, not_found (no such listing), failed (storage). A model failure is not a failure: rules still score.
const c = $('Context').first().json.ctx;
if (!c || c.ok !== true) {
  return [{ json: { ok: false, status: 'not_found', listing_id: $('Start').first().json.listing_id || null,
    transient: false, error: `context: ${(c && c.error_code) || 'no answer'}`, steps: [] } }];
}
const x = $('Score').first().json;
if (!x.ok) return [{ json: { ok: false, status: 'failed', listing_id: x.listing_id, transient: x.transient, error: x.error, steps: x.steps } }];
const st = ($('Store check').first().json || {}).r || {};
if (!st.ok) {
  return [{ json: { ok: false, status: 'failed', listing_id: x.listing_id, transient: false,
    error: `store: ${st.error_code || 'no answer'}${st.field ? ' (' + st.field + ')' : ''}`, steps: x.steps } }];
}
return [{ json: { ok: true, status: 'checked', listing_id: x.listing_id, check_id: st.check_id, ...x.summary,
  transient: false, error: null, steps: x.steps } }];