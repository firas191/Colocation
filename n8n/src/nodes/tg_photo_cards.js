// wf.channel.telegram > "Photo cards": one photo card per result that has photos, for the first telegram.search_photo_cards
// results (D-086). The card is drawn by the Media service: the first photo, then the next ones blurred with "+N".
/* @include lib/tg_texts.js */
const P = $('Plan').first().json;
const row = $input.first().json;
const d = $('API: ask assistant').first().json.body.data;
const byId = Object.fromEntries((d.results || []).map((x) => [x.id, x]));
const media = String(row.media_url || '').replace(/\/+$/, '');
return (row.s || []).filter((x) => x.count > 0 && x.position <= P.photo_cards).map((x) => {
  const res = byId[x.listing_id] || {};
  const rent = res.rent || {};
  const price = rent.amount_minor != null ? tgMoney(rent.amount_minor, rent.currency, rent.exponent) +
    (rent.period === 'week' ? T(P.lang, 'per_week') : T(P.lang, 'per_month')) : '';
  const where = [res.neighbourhood, res.city].filter(Boolean).join(', ');
  const title = res.title || T(P.lang, 'kind_' + (res.kind || 'room'));
  return { json: { chat_id: P.chat_id, listing_id: x.listing_id, total: x.count, more: x.count - 1,
    url: `${media}/v1/images/card`, body: JSON.stringify({ keys: x.keys.map((k) => k.key), total: x.count }),
    caption: `${x.position}. <b>${tgEsc(title)}</b>\n${[price, tgEsc(where)].filter(Boolean).join(' · ')}`,
    button: T(P.lang, 'view_photos', { n: x.count }), callback: `ph:${x.listing_id}` } };
});
