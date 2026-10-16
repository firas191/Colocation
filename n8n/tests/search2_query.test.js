// GET /v2/search parameters (n8n/src/lib/search2_query.js, platform P2).
const test = require('node:test');
const assert = require('node:assert');
const { parseSearch2, makeCursor, readCursor } = require('../src/lib/search2_query.js');

const J = { accountJurisdiction: 'TN' };

test('v1 parameters keep their rules; the account jurisdiction is the default', () => {
  const r = parseSearch2({ q: ' chambre ', max_rent: '400000', near: 'Ariana', limit: '5' }, J);
  assert.deepStrictEqual(r.details, []);
  assert.strictEqual(r.input.q, 'chambre');
  assert.strictEqual(r.input.max_rent_minor, 400000);
  assert.strictEqual(r.input.limit, 5);
  assert.strictEqual(r.offset, 0);
  const bad = parseSearch2({ lat: '36.8', max_rent: '-1', period: 'year' }, {});
  assert.deepStrictEqual(bad.details.map((d) => d.field).sort(), ['jurisdiction', 'lng', 'max_rent', 'period']);
});

test('new filters are parsed into what the database function takes', () => {
  const r = parseSearch2({ kind: 'room', furnished: 'true', bills_included: 'false', available_by: '2026-12-01',
    amenities: 'wifi, desk,wifi', house_rules: 'smoking:no,pets:yes', bbox: '10.0,36.7,10.3,36.9' }, J);
  assert.deepStrictEqual(r.details, []);
  assert.strictEqual(r.input.furnished, true);
  assert.strictEqual(r.input.bills_included, false);
  assert.deepStrictEqual(r.input.amenities, ['wifi', 'desk']);
  assert.deepStrictEqual(r.input.house_rules, { smoking: 'no', pets: 'yes' });
  assert.deepStrictEqual(r.input.bbox, [10, 36.7, 10.3, 36.9]);
});

test('bad filters are named one by one', () => {
  const r = parseSearch2({ kind: 'castle', furnished: 'yes', available_by: '2026-13-40', amenities: 'wifi,jacuzzi',
    house_rules: 'smoking=no,women:no', bbox: '10,37,9,36', ids: 'x', foo: '1' }, J);
  const got = r.details.map((d) => `${d.field}:${d.issue}`).sort();
  assert.deepStrictEqual(got, ['amenities:unknown_amenity', 'available_by:invalid_date', 'bbox:min_must_be_below_max',
    'foo:unknown_parameter', 'furnished:must_be_true_or_false', 'house_rules:invalid_format', 'house_rules:invalid_format',
    'ids:invalid_format', 'kind:not_allowed']);
  assert.deepStrictEqual(parseSearch2({ bbox: '0,0,91,1' }, J).details[0], { field: 'bbox', issue: 'too_large', max_degrees: 90 });
  assert.deepStrictEqual(parseSearch2({ bbox: '2.63761,33.42386,16.24953,37.74140' }, J).details, []);   // F-075: desktop view of Tunisia
  assert.strictEqual(parseSearch2({ amenities: Array(11).fill('wifi').map((a, i) => a + i).join(',') }, J).details[0].issue, 'too_many');
  assert.strictEqual(parseSearch2({ kind: ['room', 'room'] }, J).details[0].issue, 'repeated_parameter');
});

test('a cursor carries its offset and is refused with other filters', () => {
  const first = parseSearch2({ q: 'wifi', furnished: 'true' }, J);
  const c = makeCursor(20, first.fingerprint);
  assert.deepStrictEqual(readCursor(c), { offset: 20, fingerprint: first.fingerprint });
  const next = parseSearch2({ q: 'wifi', furnished: 'true', cursor: c, limit: '10' }, J);
  assert.deepStrictEqual(next.details, []);
  assert.strictEqual(next.offset, 20);
  const other = parseSearch2({ q: 'wifi', furnished: 'false', cursor: c }, J);
  assert.deepStrictEqual(other.details, [{ field: 'cursor', issue: 'invalid_cursor' }]);
  assert.strictEqual(parseSearch2({ cursor: 'not a cursor!' }, J).details[0].issue, 'invalid_cursor');
  assert.strictEqual(readCursor('bzEyMy56enp6enp6eg'), null);
});
