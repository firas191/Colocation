// wf.api.profiles_me > "Validate body"
// PUT /v1/profiles/me: save or correct the caller's search profile. The whole profile is
// sent (fields left out become empty). Money in minor units of currency (spec 4.2).
/* @include lib/schema_lite.js */
const gw = $input.first().json;
const b = gw.ctx.body || {};
const nint = (max) => ({ type: ['integer', 'null'], minimum: 0, maximum: max });
const PREF = { type: 'string' };
const schema = {
  type: 'object', additionalProperties: false, required: ['jurisdiction_code'],
  properties: {
    jurisdiction_code: { type: 'string', pattern: '^[A-Z]{2}(-[A-Z0-9]{1,3})?$' },
    budget_min_minor: nint(1e12), budget_max_minor: nint(1e12),
    currency: { type: ['string', 'null'], pattern: '^[A-Z]{3}$' },
    budget_period: { type: ['string', 'null'], enum: ['month', 'week', null] },
    anchor_label: { type: ['string', 'null'], maxLength: 120 },
    anchor_lat: { type: ['number', 'null'], minimum: -90, maximum: 90 },
    anchor_lng: { type: ['number', 'null'], minimum: -180, maximum: 180 },
    max_commute_min: nint(300), search_radius_m: { type: ['integer', 'null'], minimum: 100, maximum: 100000 },
    move_in_from: { type: ['string', 'null'], pattern: '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' },
    min_stay_months: nint(120),
    declared_preferences: { type: 'object', additionalProperties: false, properties: {
      smoking: { ...PREF, enum: ['yes', 'no'] }, pets: { ...PREF, enum: ['yes', 'no'] }, quiet_hours: { ...PREF, enum: ['yes', 'no'] },
      guests: { ...PREF, enum: ['yes', 'no'] }, schedule: { ...PREF, enum: ['early', 'late', 'irregular'] },
      cleanliness: { ...PREF, enum: ['high', 'medium', 'relaxed'] } } },
    languages: { type: 'array', maxItems: 6, items: { type: 'string', enum: ['ar', 'aeb', 'fr', 'en', 'de', 'es', 'it'] } },
    unparsed: { type: 'array', maxItems: 10, items: { type: 'string', maxLength: 200 } },
  },
};
const errors = validate(schema, b);
const details = errors.map((e) => ({ field: e.path.replace(/^\$\.?/, '') || 'body', issue: e.issue }));
if (!errors.length) {
  if ((b.budget_min_minor != null || b.budget_max_minor != null) && !b.currency) details.push({ field: 'currency', issue: 'required_with_budget' });
  if (b.budget_min_minor != null && b.budget_max_minor != null && b.budget_min_minor > b.budget_max_minor) details.push({ field: 'budget_min_minor', issue: 'greater_than_max' });
  if ((b.anchor_lat == null) !== (b.anchor_lng == null)) details.push({ field: 'anchor_lat', issue: 'lat_and_lng_go_together' });
  if (b.move_in_from && Number.isNaN(Date.parse(b.move_in_from + 'T00:00:00Z'))) details.push({ field: 'move_in_from', issue: 'invalid_date' });
  else if (b.move_in_from && new Date(b.move_in_from + 'T00:00:00Z').toISOString().slice(0, 10) !== b.move_in_from) details.push({ field: 'move_in_from', issue: 'invalid_date' });
}
if (details.length) {
  return [{ json: { ok: false, status: 422, gw, error: { code: 'VALIDATION_FAILED', message: 'Request body is invalid', details } } }];
}
const body = { ...b, budget_period: b.budget_period || ((b.budget_min_minor != null || b.budget_max_minor != null) ? 'month' : null) };
return [{ json: { ok: true, gw, params: [gw.ctx.user_id, JSON.stringify(body)] } }];
