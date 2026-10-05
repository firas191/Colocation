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
