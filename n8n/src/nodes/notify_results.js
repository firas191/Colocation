// wf.notify.dispatch > "E-mail results" / "Telegram results": each send node gives one item per item it got, in the
// same order; an error is in json.error (the node goes on). The list goes to app.deliveries_done (retries there).
const sent = $input.all();
const src = $('__SOURCE__').all();
const out = src.map((s, k) => {
  const r = (sent[k] || {}).json || {};
  const err = r.error ? String(r.error.message || r.error).slice(0, 200) : null;
  return { delivery_id: s.json.delivery_id, ok: !err, error: err };
});
return [{ json: { results: JSON.stringify(out) } }];
