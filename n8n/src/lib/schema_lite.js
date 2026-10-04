// Small JSON Schema validator for LLM outputs and request bodies (spec 9.2: validate every
// output against its schema). n8n Code nodes cannot load packages (no require), so this
// covers the subset the schemas in prompts/schemas/ use: type (one or a list, including
// "null" and "integer"), enum, const, required, properties, additionalProperties (boolean
// or schema), items, minItems, maxItems, minimum, maximum, minLength, maxLength, pattern.
// Anything else in a schema is ignored. Cross-checked against the Python jsonschema package
// in tests/unit/test_prompts.py.
// Returns a list of errors [{path, issue, ...}]; empty when the value is valid.

function typeOf(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (typeof v === 'number') return Number.isInteger(v) ? 'integer' : 'number';
  return typeof v;            // string, boolean, object
}

function typeMatches(t, v) {
  const actual = typeOf(v);
  if (t === actual) return true;
  if (t === 'number' && actual === 'integer') return true;
  return false;
}

function validate(schema, value, path = '$', errors = []) {
  if (!schema || typeof schema !== 'object') return errors;
  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((t) => typeMatches(t, value))) {
      errors.push({ path, issue: 'type', expected: types.join('|'), got: typeOf(value) });
      return errors;
    }
  }
  if (schema.enum !== undefined && !schema.enum.some((e) => e === value)) {
    errors.push({ path, issue: 'enum', allowed: schema.enum });
  }
  if (schema.const !== undefined && schema.const !== value) errors.push({ path, issue: 'const' });
  const t = typeOf(value);
  if (t === 'string') {
    // length in code points, as JSON Schema counts it
    const len = Array.from(value).length;
    if (schema.minLength !== undefined && len < schema.minLength) errors.push({ path, issue: 'minLength', min: schema.minLength });
    if (schema.maxLength !== undefined && len > schema.maxLength) errors.push({ path, issue: 'maxLength', max: schema.maxLength });
    if (schema.pattern !== undefined && !new RegExp(schema.pattern, 'u').test(value)) errors.push({ path, issue: 'pattern' });
  }
  if (t === 'integer' || t === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) errors.push({ path, issue: 'minimum', min: schema.minimum });
    if (schema.maximum !== undefined && value > schema.maximum) errors.push({ path, issue: 'maximum', max: schema.maximum });
  }
  if (t === 'array') {
    if (schema.minItems !== undefined && value.length < schema.minItems) errors.push({ path, issue: 'minItems', min: schema.minItems });
    if (schema.maxItems !== undefined && value.length > schema.maxItems) errors.push({ path, issue: 'maxItems', max: schema.maxItems });
    if (schema.items) value.forEach((v, i) => validate(schema.items, v, `${path}[${i}]`, errors));
  }
  if (t === 'object') {
    for (const k of schema.required || []) {
      if (!Object.prototype.hasOwnProperty.call(value, k)) errors.push({ path: `${path}.${k}`, issue: 'required' });
    }
    const props = schema.properties || {};
    for (const [k, v] of Object.entries(value)) {
      if (Object.prototype.hasOwnProperty.call(props, k)) validate(props[k], v, `${path}.${k}`, errors);
      else if (schema.additionalProperties === false) errors.push({ path: `${path}.${k}`, issue: 'additional_property' });
      else if (schema.additionalProperties && typeof schema.additionalProperties === 'object') {
        validate(schema.additionalProperties, v, `${path}.${k}`, errors);
      }
    }
  }
  return errors;
}

// One line per error, for retry prompts and logs.
function describe(errors, max = 8) {
  return errors.slice(0, max).map((e) => {
    switch (e.issue) {
      case 'type': return `${e.path}: expected ${e.expected}, got ${e.got}`;
      case 'enum': return `${e.path}: must be one of ${JSON.stringify(e.allowed)}`;
      case 'required': return `${e.path}: missing`;
      case 'additional_property': return `${e.path}: not allowed`;
      default: return `${e.path}: ${e.issue}`;
    }
  }).join('; ');
}

if (typeof module !== 'undefined') module.exports = { validate, describe, typeOf };
