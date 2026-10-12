// wf.channel.telegram > "Format answer": the assistant's answer (POST /v1/assistant/message) as a Telegram message.
/* @include lib/tg_texts.js */
const P = $('Plan').first().json;
const r = $input.first().json;
const lang = P.lang;
const out = (text) => [{ json: { chat_id: P.chat_id, text } }];
const err = tgApiError(lang, r);
if (err) return out(err);
const d = r.body.data || {};
if (d.status === 'clarification_needed') return out(T(lang, 'clarify', { q: d.clarifying_question || '' }));
if (d.status === 'not_available_yet') {
  if (d.intent === 'legal_question') return out(T(lang, 'legal_later'));
  if (d.intent === 'post_listing') return out(T(lang, 'post_hint'));
  return out(T(lang, 'later'));
}
if (d.status === 'unsupported' || d.status === 'not_understood') return out(T(lang, 'unsupported'));
// the Legal agent (D-087): the answer with its numbered sources, or "not found"; the notice (legal.notice_version) always
if (d.intent === 'legal_question' && (d.status === 'answered' || d.status === 'abstained')) {
  if (d.status === 'abstained' || !d.answer) return out(T(lang, 'legal_not_found', { c: d.jurisdiction || '?' }) + '\n\n' + T(lang, 'legal_notice'));
  const lines = [];
  if (d.conflict) lines.push(T(lang, 'legal_conflict'));
  lines.push(tgEsc(d.answer), '', T(lang, 'legal_sources'));
  for (const c of d.citations || []) {
    const title = tgEsc(c.title || c.cite_as || '?');
    const url = c.url && /^https?:\/\//.test(c.url) ? tgEsc(c.url).replace(/"/g, '%22') : null;
    const bits = [url ? `<a href="${url}">${title}</a>` : title];
    if (c.article) bits.push(tgEsc(c.article));               // already a full reference, e.g. "COC art. 729"
    if (c.source_type) bits.push(T(lang, 'type_' + c.source_type));
    if (c.retrieved_at) bits.push(T(lang, 'legal_seen', { d: String(c.retrieved_at).slice(0, 10) }));
    lines.push(`[${c.n}] ${bits.join(' · ')}`);
  }
  lines.push('', T(lang, 'legal_notice'));
  return out(lines.join('\n'));
}
// the owner assistant proposed a change (D-088): its sentence, then what would change (from the database), and the
// two buttons (sent by "Send proposal")
if (d.status === 'proposed' && d.proposal) {
  const pr = d.proposal;
  const lines = [];
  if (d.answer) lines.push(tgEsc(d.answer), '');
  lines.push(T(lang, 'owner_proposed', { n: pr.listing_number ?? 1 }), ...tgDiff(lang, pr.diff));
  return [{ json: { chat_id: P.chat_id, text: lines.join('\n'), proposal: true,
    confirm_label: T(lang, 'owner_confirm'), cancel_label: T(lang, 'owner_cancel'),
    confirm_data: `lc:${pr.change_id}`, cancel_data: `lx:${pr.change_id}` } }];
}
// the Match agent answered a question about an earlier result, without a new search (D-084)
if (d.status === 'answered' && d.answer) return out(tgEsc(d.answer));
if (d.status !== 'results') return out(T(lang, 'failed', { code: d.status }));
// what was understood (P2 profile), then the listings
const pr = d.profile || {};
const what = [];
const cur = pr.currency;
if (pr.budget_max_minor != null) what.push(T(lang, 'budget_max', { v: tgMoney(pr.budget_max_minor, cur) + (pr.budget_period === 'week' ? T(lang, 'per_week') : T(lang, 'per_month')) }));
const place = (d.anchor && d.anchor.place && (d.anchor.place.name || d.anchor.place.label)) || pr.anchor_label;
if (place) what.push(T(lang, 'near', { p: place }));
if (pr.move_in_from) what.push(T(lang, 'move_in', { d: pr.move_in_from }));
const lines = [];
// with the Match agent, its checked answer first; the filters used and the cards below come from the data (D-084)
if (d.answer) lines.push(tgEsc(d.answer));
if (what.length) lines.push(T(lang, 'understood', { _raw: { what: what.join(' · ') } }));
const res = d.results || [];
if (!res.length) lines.push(T(lang, 'no_results'));
else {
  lines.push(T(lang, 'results', { n: d.count ?? res.length }) + (res.some((x) => x.is_synthetic) ? ' ' + T(lang, 'synthetic') : ''));
  res.slice(0, 5).forEach((x, i) => {
    const rent = x.rent || {};
    const price = rent.amount_minor != null ? tgMoney(rent.amount_minor, rent.currency, rent.exponent) + (rent.period === 'week' ? T(lang, 'per_week') : T(lang, 'per_month')) : '';
    const where = [x.neighbourhood, x.city].filter(Boolean).join(', ');
    const dist = x.distance_m != null ? `${(Number(x.distance_m) / 1000).toFixed(1)} km` : '';
    lines.push(`${i + 1}. <b>${tgEsc(x.title || T(lang, 'kind_' + (x.kind || 'room')))}</b>\n   ${[price, tgEsc(where), dist].filter(Boolean).join(' · ')}`);
  });
  if (res.length > 5) lines.push(T(lang, 'more', { n: res.length - 5 }));
}
return out(lines.join('\n'));
