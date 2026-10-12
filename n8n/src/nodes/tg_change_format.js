// wf.channel.telegram > "Format change": the answer to the buttons under a proposed change (D-088). Confirm: what
// PATCH /v1/listings/:id changed, and whether the listing is now published or what it still misses. Cancel: said so.
/* @include lib/tg_texts.js */
const P = $('Plan').first().json;
const lang = P.lang;
const out = (text) => [{ json: { chat_id: P.chat_id, text } }];
const pc = $('Pending change').first().json || {};
if (P.decision === 'cancel') return out(pc.cancelled && pc.cancelled.cancelled ? T(lang, 'owner_cancelled') : T(lang, 'owner_gone'));
if (!pc.listing_id) return out(T(lang, 'owner_gone'));
const r = $input.first().json;
if (r.status === 409 || r.status === 404) return out(T(lang, 'owner_gone'));
if (r.status === 422) {
  const why = ((r.body && r.body.error && r.body.error.details) || []).map((e) => `${e.field}: ${e.issue}`).join(', ');
  return out(T(lang, 'owner_refused', { why: why || '?' }));
}
const err = tgApiError(lang, r);
if (err) return out(err);
const d = r.body.data || {};
const lines = [T(lang, 'owner_done'), ...tgDiff(lang, d.diff)];
const pub = d.publication;
if (pub && pub.published) lines.push('', T(lang, 'published'));
else if (pub && (pub.missing || []).length) {
  lines.push('', T(lang, 'not_published', { missing: pub.missing.map((k) => T(lang, 'missing_' + k)).join(', ') }));
} else if (!d.diff.some((x) => x.field === 'status')) lines.push('', T(lang, 'owner_status', { s: T(lang, 'st_' + d.status) }));
return out(lines.join('\n'));
