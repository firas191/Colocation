// wf.api.search > "Validate query"
// GET /v1/search?q=&jurisdiction=&max_rent=&currency=&period=&lat=&lng=&near=&radius_m=&limit=&use_profile=
// max_rent is in minor units of currency (spec 4.2); near is a place name resolved by the
// local gazetteer; use_profile=true fills missing filters from the saved profile.
const gw = $input.first().json;
const q = gw.ctx.query || {};
const user = gw.ctx.user || {};
const details = [];
const allowed = ['q', 'jurisdiction', 'max_rent', 'currency', 'period', 'lat', 'lng', 'near', 'radius_m', 'limit', 'use_profile'];
for (const k of Object.keys(q)) if (!allowed.includes(k)) details.push({ field: k, issue: 'unknown_parameter' });
const str = (k) => (q[k] === undefined || q[k] === null ? '' : String(q[k]).trim());
const int = (k, lo, hi) => {
  const v = str(k);
  if (!v) return null;
  if (!/^\d{1,12}$/.test(v) || Number(v) < lo || Number(v) > hi) { details.push({ field: k, issue: `must_be_integer_${lo}_${hi}` }); return null; }
  return Number(v);
};
const num = (k, lo, hi) => {
  const v = str(k);
  if (!v) return null;
  const n = Number(v);
  if (!/^-?\d{1,3}(\.\d{1,8})?$/.test(v) || n < lo || n > hi) { details.push({ field: k, issue: `must_be_number_${lo}_${hi}` }); return null; }
  return n;
};
const text = str('q');
if (Array.from(text).length > 300) details.push({ field: 'q', issue: 'too_long', max: 300 });
const jurisdiction = str('jurisdiction');        // explicit; else the profile's (use_profile), else the account's
if (jurisdiction && !/^[A-Z]{2}(-[A-Z0-9]{1,3})?$/.test(jurisdiction)) details.push({ field: 'jurisdiction', issue: 'invalid_format' });
const max_rent = int('max_rent', 0, 1e12);
const currency = str('currency').toUpperCase() || null;
if (currency && !/^[A-Z]{3}$/.test(currency)) details.push({ field: 'currency', issue: 'invalid_format' });
const period = str('period') || null;
if (period && !['month', 'week'].includes(period)) details.push({ field: 'period', issue: 'must_be_month_or_week' });
const lat = num('lat', -90, 90), lng = num('lng', -180, 180);
if ((lat === null) !== (lng === null)) details.push({ field: lat === null ? 'lat' : 'lng', issue: 'lat_and_lng_go_together' });
const near = str('near');
if (Array.from(near).length > 120) details.push({ field: 'near', issue: 'too_long', max: 120 });
const radius_m = int('radius_m', 100, 100000);
const limit = int('limit', 1, 50);
const up = str('use_profile');
if (up && !['true', 'false'].includes(up)) details.push({ field: 'use_profile', issue: 'must_be_true_or_false' });
if (!jurisdiction && up !== 'true' && !user.jurisdiction_code) details.push({ field: 'jurisdiction', issue: 'required' });
if (details.length) {
  return [{ json: { ok: false, status: 422, gw, error: { code: 'VALIDATION_FAILED', message: 'Query parameters are invalid', details } } }];
}
const input = { q: text, jurisdiction: jurisdiction || null, account_jurisdiction: user.jurisdiction_code || null, max_rent_minor: max_rent, currency, budget_period: period,
  lat, lng, place: near || null, radius_m, limit };
return [{ json: { ok: true, gw, input, params: [gw.ctx.user_id || '', up === 'true'] } }];
