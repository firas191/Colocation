// The shared validator of the platform endpoints (n8n/src/nodes/platform_validate.js, build_platform.py).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const src = path.join(__dirname, '..', 'src');
function node(spec) {
  let code = fs.readFileSync(path.join(src, 'nodes', 'platform_validate.js'), 'utf8');
  code = code.replace(/\/\* @include ([\w/.-]+) \*\//g, (_, f) => fs.readFileSync(path.join(src, f), 'utf8'));
  code = code.replaceAll('__SPEC__', JSON.stringify(spec));
  return (ctx) => new Function('$input', code)({ first: () => ({ json: { ctx } }) })[0].json;
}

const LIST = node({ query: { limit: { type: 'int', min: 1, max: 50 }, unread_only: { type: 'bool' }, before: { type: 'int', min: 1 } } });
const READ = node({ body: { type: 'object', additionalProperties: false, properties: {
  ids: { type: 'array', minItems: 1, items: { type: 'integer' } }, all: { type: 'boolean', const: true } } }, require_any: ['ids', 'all'] });
const BYID = node({ params: { id: 'uuid' } });

test('query values are converted and checked', () => {
  const r = LIST({ query: { limit: '5', unread_only: 'true' } });
  assert.deepStrictEqual(r.input.query, { limit: 5, unread_only: true });
  const bad = LIST({ query: { limit: '0', unread_only: 'yes', x: '1' } });
  assert.strictEqual(bad.status, 422);
  assert.deepStrictEqual(bad.error.details.map((d) => d.field).sort(), ['limit', 'unread_only', 'x']);
});

test('repeated query parameters are refused', () => {
  assert.strictEqual(LIST({ query: { limit: ['1', '2'] } }).error.details[0].issue, 'repeated_parameter');
});

test('body schema and one-of rule', () => {
  assert.strictEqual(READ({ body: { ids: [1, 2] } }).ok, true);
  assert.strictEqual(READ({ body: {} }).error.details[0].issue, 'one_required');
  assert.strictEqual(READ({ body: { all: false } }).status, 422);
  assert.strictEqual(READ({ body: { ids: [1], extra: 1 } }).status, 422);
});

test('a malformed id is not found, a valid one is lower-cased', () => {
  assert.strictEqual(BYID({ params: { id: 'nope' } }).status, 404);
  assert.strictEqual(BYID({ params: { id: 'AAAAAAAA-0000-4000-8000-000000000000' } }).input.params.id, 'aaaaaaaa-0000-4000-8000-000000000000');
});
