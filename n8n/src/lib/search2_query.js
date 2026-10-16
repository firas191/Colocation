// GET /v2/search query parameters (platform P2). Pure functions: inlined into wf.api.search_v2 by n8n/build.py
// and unit-tested by n8n/tests/search2_query.test.js.
//  - parseSearch2(query, {accountJurisdiction}) -> {details, input, offset, fingerprint, useProfile}
//  - makeCursor(offset, fingerprint) / readCursor(cursor) -> opaque "o<offset>.<fingerprint>" in base64url
// Amenities are the vocabulary of listing changes (app.listing_change_check, migration 0019) and of P3.
const SEARCH2_AMENITIES = ['wifi', 'washing_machine', 'air_conditioning', 'heating', 'parking', 'balcony', 'terrace', 'garden',
  'elevator', 'dishwasher', 'equipped_kitchen', 'private_bathroom', 'desk', 'fridge', 'oven', 'microwave', 'tv', 'pool',
  'gym', 'security', 'concierge'];
const SEARCH2_RULES = ['smoking', 'pets', 'guests', 'parties'];
const SEARCH2_KINDS = ['room', 'shared_flat', 'roommate_wanted'];
const SEARCH2_PARAMS = ['q', 'jurisdiction', 'max_rent', 'currency', 'period', 'lat', 'lng', 'near', 'radius_m', 'limit',
  'use_profile', 'kind', 'furnished', 'bills_included', 'available_by', 'amenities', 'house_rules', 'bbox', 'ids', 'cursor'];
const SEARCH2_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// FNV-1a, 32 bits, as 8 hex characters: enough to tell two parameter sets apart, not a security measure.
function search2Hash(s) {
  let h = 0x811c9dc5;
  for (const ch of String(s)) {
    h ^= ch.codePointAt(0);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

function b64url(s) {
  const b = typeof Buffer !== 'undefined' ? Buffer.from(s, 'utf8').toString('base64') : btoa(s);
  return b.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function unb64url(s) {
  const t = String(s).replace(/-/g, '+').replace(/_/g, '/');
  return typeof Buffer !== 'undefined' ? Buffer.from(t, 'base64').toString('utf8') : atob(t);
}

function makeCursor(offset, fingerprint) {
  return b64url(`o${offset}.${fingerprint}`);
}
function readCursor(cursor) {
  if (!/^[A-Za-z0-9_-]{4,64}$/.test(String(cursor))) return null;
  let t;
  try { t = unb64url(cursor); } catch (e) { return null; }
  const m = /^o(\d{1,6})\.([0-9a-f]{8})$/.exec(t);
  return m ? { offset: Number(m[1]), fingerprint: m[2] } : null;
}

function parseSearch2(q, opts = {}) {
  q = q || {};
  const details = [];
  for (const k of Object.keys(q)) {
    if (!SEARCH2_PARAMS.includes(k)) details.push({ field: k, issue: 'unknown_parameter' });
    else if (Array.isArray(q[k])) details.push({ field: k, issue: 'repeated_parameter' });
  }
  const str = (k) => (q[k] === undefined || q[k] === null || Array.isArray(q[k]) ? '' : String(q[k]).trim());
  const int = (k, lo, hi) => {
    const v = str(k);
    if (!v) return null;
    if (!/^\d{1,12}$/.test(v) || Number(v) < lo || Number(v) > hi) { details.push({ field: k, issue: `must_be_integer_${lo}_${hi}` }); return null; }
    return Number(v);
  };
  const num = (v, k, lo, hi) => {
    const n = Number(v);
    if (!/^-?\d{1,3}(\.\d{1,8})?$/.test(v) || n < lo || n > hi) { details.push({ field: k, issue: `must_be_number_${lo}_${hi}` }); return null; }
    return n;
  };
  const bool = (k) => {
    const v = str(k);
    if (!v) return null;
    if (!['true', 'false'].includes(v)) { details.push({ field: k, issue: 'must_be_true_or_false' }); return null; }
    return v === 'true';
  };
  const list = (k, max) => {
    const v = str(k);
    if (!v) return [];
    const items = v.split(',').map((x) => x.trim()).filter(Boolean);
    if (items.length > max) { details.push({ field: k, issue: 'too_many', max }); return []; }
    return [...new Set(items)];
  };

  // the parameters of GET /v1/search, with the same rules
  const text = str('q');
  if (Array.from(text).length > 300) details.push({ field: 'q', issue: 'too_long', max: 300 });
  const jurisdiction = str('jurisdiction');
  if (jurisdiction && !/^[A-Z]{2}(-[A-Z0-9]{1,3})?$/.test(jurisdiction)) details.push({ field: 'jurisdiction', issue: 'invalid_format' });
  const max_rent = int('max_rent', 0, 1e12);
  const currency = str('currency').toUpperCase() || null;
  if (currency && !/^[A-Z]{3}$/.test(currency)) details.push({ field: 'currency', issue: 'invalid_format' });
  const period = str('period') || null;
  if (period && !['month', 'week'].includes(period)) details.push({ field: 'period', issue: 'must_be_month_or_week' });
  const lat = str('lat') ? num(str('lat'), 'lat', -90, 90) : null;
  const lng = str('lng') ? num(str('lng'), 'lng', -180, 180) : null;
  if ((lat === null) !== (lng === null)) details.push({ field: lat === null ? 'lat' : 'lng', issue: 'lat_and_lng_go_together' });
  const near = str('near');
  if (Array.from(near).length > 120) details.push({ field: 'near', issue: 'too_long', max: 120 });
  const radius_m = int('radius_m', 100, 100000);
  const limit = int('limit', 1, 50);
  const up = str('use_profile');
  if (up && !['true', 'false'].includes(up)) details.push({ field: 'use_profile', issue: 'must_be_true_or_false' });
  if (!jurisdiction && up !== 'true' && !opts.accountJurisdiction) details.push({ field: 'jurisdiction', issue: 'required' });

  // new in v2
  const kind = str('kind') || null;
  if (kind && !SEARCH2_KINDS.includes(kind)) details.push({ field: 'kind', issue: 'not_allowed', allowed: SEARCH2_KINDS });
  const furnished = bool('furnished');
  const bills_included = bool('bills_included');
  const available_by = str('available_by') || null;
  if (available_by && (!/^\d{4}-\d{2}-\d{2}$/.test(available_by) || isNaN(Date.parse(available_by + 'T00:00:00Z')))) {
    details.push({ field: 'available_by', issue: 'invalid_date' });
  }
  const amenities = list('amenities', 10);
  for (const a of amenities) if (!SEARCH2_AMENITIES.includes(a)) details.push({ field: 'amenities', issue: 'unknown_amenity', value: a.slice(0, 40) });
  const house_rules = {};
  for (const item of list('house_rules', 4)) {
    const m = /^([a-z]+):(yes|no)$/.exec(item);
    if (!m || !SEARCH2_RULES.includes(m[1])) { details.push({ field: 'house_rules', issue: 'invalid_format', value: item.slice(0, 40) }); continue; }
    house_rules[m[1]] = m[2];
  }
  let bbox = null;
  if (str('bbox')) {
    const parts = str('bbox').split(',').map((x) => x.trim());
    if (parts.length !== 4) details.push({ field: 'bbox', issue: 'needs_four_numbers' });
    else {
      const [a, b, c, d] = [num(parts[0], 'bbox', -180, 180), num(parts[1], 'bbox', -90, 90), num(parts[2], 'bbox', -180, 180), num(parts[3], 'bbox', -90, 90)];
      if ([a, b, c, d].every((x) => x !== null)) {
        if (a >= c || b >= d) details.push({ field: 'bbox', issue: 'min_must_be_below_max' });
        // 90 degrees: a whole-country view on a wide screen (Tunisia at 1280 px: 13.6 degrees, F-075; France at 2560 px:
        // about 72 by arithmetic). The country filter already bounds the rows; this only refuses absurd areas.
        else if (c - a > 90 || d - b > 90) details.push({ field: 'bbox', issue: 'too_large', max_degrees: 90 });
        else bbox = [a, b, c, d];
      }
    }
  }
  const ids = list('ids', 50).map((x) => x.toLowerCase());
  for (const id of ids) if (!SEARCH2_UUID.test(id)) { details.push({ field: 'ids', issue: 'invalid_format' }); break; }

  // the cursor belongs to one set of parameters: everything except cursor and limit
  const norm = {};
  for (const k of SEARCH2_PARAMS) if (k !== 'cursor' && k !== 'limit' && str(k)) norm[k] = str(k);
  const fingerprint = search2Hash(JSON.stringify(norm));
  let offset = 0;
  if (str('cursor')) {
    const c = readCursor(str('cursor'));
    if (!c || c.fingerprint !== fingerprint) details.push({ field: 'cursor', issue: 'invalid_cursor' });
    else offset = c.offset;
  }

  const input = { q: text, jurisdiction: jurisdiction || null, account_jurisdiction: opts.accountJurisdiction || null,
    max_rent_minor: max_rent, currency, budget_period: period, lat, lng, place: near || null, radius_m, limit: limit || 20,
    kind, furnished, bills_included, available_by, amenities: amenities.length ? amenities : null,
    house_rules: Object.keys(house_rules).length ? house_rules : null, bbox, ids: ids.length ? ids : null };
  return { details, input, offset, fingerprint, useProfile: up === 'true' };
}

if (typeof module !== 'undefined') {
  module.exports = { parseSearch2, makeCursor, readCursor, search2Hash, SEARCH2_AMENITIES, SEARCH2_RULES, SEARCH2_KINDS };
}
