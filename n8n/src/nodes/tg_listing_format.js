// wf.channel.telegram > "Format listing": what P3 read in the listing, the issues for the owner (D-077), and what
// happened to the photo (from GET /v1/listings/:id). Or, when the wait ended first, where to find the listing later.
/* @include lib/tg_texts.js */
const P = $('Plan').first().json;
const lang = P.lang;
const id = $('API: create listing').first().json.body.data.listing_id;
const r = $input.first().json;
if (r.state === 2) return [{ json: { chat_id: P.chat_id, text: T(lang, 'listing_late', { id }) } }];
const err = tgApiError(lang, r);
if (err) return [{ json: { chat_id: P.chat_id, text: err } }];
const v = r.body.data;
const parts = [];
if (v.kind) parts.push(T(lang, 'kind_' + v.kind));
if (v.rent_minor != null) parts.push(tgMoney(v.rent_minor, v.currency) + (v.rent_period === 'week' ? T(lang, 'per_week') : T(lang, 'per_month')));
if (v.bills_included === true) parts.push(T(lang, 'bills_in'));
if (v.bills_included === false) parts.push(T(lang, 'bills_out'));
if (v.deposit_minor != null) parts.push(T(lang, 'deposit', { v: tgMoney(v.deposit_minor, v.currency) }));
if (v.bedrooms != null) parts.push(T(lang, 'bedrooms', { n: v.bedrooms }));
if (v.furnished === true) parts.push(T(lang, 'furnished'));
if (v.furnished === false) parts.push(T(lang, 'unfurnished'));
if (v.available_from) parts.push(T(lang, 'from', { d: String(v.available_from).slice(0, 10) }));
const where = [v.neighbourhood, v.city].filter(Boolean).join(', ');
if (where) parts.push(tgEsc(where));
if ((v.amenities || []).length) parts.push(tgEsc(v.amenities.join(', ')));
const rules = Object.entries(v.house_rules || {}).map(([k, x]) => (((TG_RULES[lang] || TG_RULES.fr)[k] || {})[x]) || `${k}: ${x}`);
if (rules.length) parts.push(tgEsc(rules.join(', ')));
const lines = [T(lang, 'fields'), parts.length ? parts.join(' · ') : T(lang, 'none')];
const issues = ((v.extraction || {}).issues || []).map((c) => (TG_ISSUES[lang] || TG_ISSUES.fr)[c] || c);
if (issues.length) lines.push('', T(lang, 'issues'), ...issues.map((x) => `• ${tgEsc(x)}`));
// Automatic publication (D-083): only reported when it ran (setting listing.auto_publish on).
const pub = (v.extraction || {}).publication;
if (v.status === 'published') lines.push('', T(lang, 'published'));
else if (pub && pub.mode === 'auto' && !pub.published) {
  lines.push('', T(lang, 'not_published', { missing: (pub.missing || []).map((k) => T(lang, 'missing_' + k)).join(', ') }));
}
const media = (v.media || []).filter((m) => m.kind === 'photo');
const rejected = (v.uploads || []).filter((u) => u.kind === 'photo' && u.status === 'rejected');
if (media.length || rejected.length) {
  const blur = media.reduce((a, m) => a + Object.values((((m.analysis || {}).blur || {}).counts) || {}).reduce((x, y) => x + Number(y || 0), 0), 0);
  lines.push('', T(lang, 'photos', { ok: media.length, bad: rejected.length, _raw: { blur: blur ? T(lang, 'blurred', { n: blur }) : '' } }));
}
return [{ json: { chat_id: P.chat_id, text: lines.join('\n') } }];
