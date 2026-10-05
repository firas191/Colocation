// wf.listing.extract > "Result": {ok, status, listing_id, issues, transient, error, steps}.
// status: extracted, no_text (nothing to extract), failed (model or storage); transient failures are
// retried by the analyze job (spec 5.6).
const c = $('Context').first().json;
if (!c.text || !String(c.text).trim()) {
  return [{ json: { ok: true, status: 'no_text', listing_id: c.listing_id, issues: [], transient: false, error: null, steps: [] } }];
}
const x = $('Check listing').first().json;
if (!x.ok) return [{ json: { ok: false, status: 'failed', listing_id: x.listing_id, issues: [], transient: x.transient, error: x.error, steps: x.steps } }];
const st = ($('Store extraction').first().json || {}).r || {};
if (!st.ok) {
  return [{ json: { ok: false, status: 'failed', listing_id: x.listing_id, issues: [], transient: false,
    error: `store: ${st.error_code || 'no answer'}${st.message ? ' (' + st.message + ')' : ''}`, steps: x.steps } }];
}
return [{ json: { ok: true, status: 'extracted', listing_id: x.listing_id, ...x.summary, transient: false, error: null, steps: x.steps } }];
