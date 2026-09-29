// Unit tests for n8n/src/lib/canonical.js and n8n/src/lib/errors.js.
// Run: node --test n8n/tests/
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { buildPath, canonicalQuery, header, correlationId, UUID_RE } = require('../src/lib/canonical.js');
const { errorText, redactPg } = require('../src/lib/errors.js');

const V = JSON.parse(fs.readFileSync(path.join(__dirname, '../../tests/vectors/signing.json'), 'utf8'));

// Query params as n8n's webhook parser delivers them: repeated keys become arrays.
function asExpressQuery(pairs) {
  const q = {};
  for (const [k, v] of pairs || []) q[k] = k in q ? [].concat(q[k], v) : v;
  return q;
}

for (const v of V.vectors) {
  test(`vector ${v.name}: canonical query and signature match the Python client`, () => {
    const q = canonicalQuery(asExpressQuery(v.query_params));
    assert.equal(q.ok, true);
    assert.equal(q.value, v.canonical_query);
    const body = Buffer.from(v.body_utf8, 'utf8');
    const canon = ['FS1-HMAC-SHA256', v.timestamp, v.method, v.path, q.value, v.request_id, v.user_id,
      v.idempotency_key, v.client_ip, crypto.createHash('sha256').update(body).digest('hex')].join('\n');
    assert.equal(canon, v.canonical_string);
    assert.equal(crypto.createHmac('sha256', Buffer.from(V.secret, 'utf8')).update(canon, 'utf8').digest('hex'), v.signature);
  });
}

test('canonicalQuery rejects nested values (qs-style a[b]=1)', () => {
  assert.deepEqual(canonicalQuery({ a: { b: '1' } }), { ok: false, field: 'a' });
  assert.deepEqual(canonicalQuery({ a: ['1', { x: 1 }] }), { ok: false, field: 'a' });
});

test('canonicalQuery of nothing is empty', () => {
  assert.deepEqual(canonicalQuery(undefined), { ok: true, value: '' });
  assert.deepEqual(canonicalQuery({}), { ok: true, value: '' });
});

test('canonicalQuery sorts by encoded key and keeps value order', () => {
  assert.equal(canonicalQuery({ b: ['2', '1'], a: 'z' }).value, 'a=z&b=2&b=1');
});

test('buildPath fills and encodes parameters', () => {
  assert.equal(buildPath('/v1/listings/:id/analyze', { id: 'ab/c d' }), '/v1/listings/ab%2Fc%20d/analyze');
  assert.equal(buildPath('/v1/health', {}), '/v1/health');
  assert.equal(buildPath('/v1/x/:id', {}), '/v1/x/');
});

test('header returns the first non-empty value', () => {
  assert.equal(header({ 'x-a': 'v' }, 'x-a'), 'v');
  assert.equal(header({ 'x-a': '' }, 'x-a'), null);
  assert.equal(header({ 'x-a': ['p', 'q'] }, 'x-a'), 'p');
  assert.equal(header(undefined, 'x-a'), null);
});

test('correlationId is a v4-shaped uuid', () => {
  for (let i = 0; i < 100; i++) assert.match(correlationId(), UUID_RE);
});

test('errorText handles strings, objects and nesting', () => {
  assert.equal(errorText({ error: 'boom' }), 'boom');
  assert.equal(errorText({ error: { message: 'm', description: 'd' } }), 'm | d');
  assert.equal(errorText({ error: { code: 1 } }), '{"code":1}');
  assert.equal(errorText(null), '');
});

test('redactPg removes values from Postgres key details', () => {
  assert.equal(redactPg('Key (email)=(a@b.c) already exists.'), 'Key (email)=(redacted) already exists.');
  assert.equal(redactPg('Key (jurisdiction_code)=(ZZ) is not present'), 'Key (jurisdiction_code)=(redacted) is not present');
});
