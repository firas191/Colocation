// wf.channel.telegram > "Result ids": the listings shown in the answer (the first five), for their photos (D-086).
const P = $('Plan').first().json;
const r = $('API: ask assistant').first().json;
const d = (r.body && r.body.data) || {};
const ids = d.status === 'results' && P.photo_cards > 0 ? (d.results || []).slice(0, 5).map((x) => x.id) : [];
return [{ json: { ids: `{${ids.join(',')}}` } }];
