// A3 Match agent checks (D-084): n8n/src/lib/agent_check.js
const test = require('node:test');
const assert = require('node:assert/strict');
const { toolCalls, readings, checkAnswer, fallbackMask } = require('../src/lib/agent_check.js');

test('numbers are read as written in listings and answers', () => {
  assert.deepEqual(readings('450.000 DT'), [[450000, 450]]);
  assert.deepEqual(readings('1.225.000 DT, 450,5 €, 12 m2'), [[1225000], [450.5], [12], [2]]);
  assert.deepEqual(readings('libre le 2026-11-01'), [[2026], [11], [1]]);
});

test('an answer passes only with numbers from the message, the memory or the tools', () => {
  const tool = [{ found: 2, results: [{ number: 1, rent: 400, currency: 'TND', distance_km: 0.3, available_from: '2026-11-15' }] }];
  assert.ok(checkAnswer("J'ai trouvé 2 annonces sous 450 DT ; la 1 est à 400 DT, à 0,3 km.", ['moins de 450 dt', ...tool]).ok);
  assert.ok(checkAnswer('La 1 est à 400.000 DT, libre le 15/11.', ['x', ...tool]).ok);       // dinars with three decimals
  assert.ok(checkAnswer('Les résultats 1, 2 et 3.', []).ok);                                // positions and small counts
  assert.deepEqual(checkAnswer('La moins chère est à 380 DT.', ['450 dt', ...tool]), { ok: false, unsupported: [380] });
  assert.ok(checkAnswer('Comme avant, la 1 à 520 DT.', ['', '{"content":"rent 520"}']).ok);   // from the memory
});

test('intermediate steps of the AI Agent node become tool calls', () => {
  const steps = [{ action: { tool: 'search_listings', toolInput: { request: 'chambre' } }, observation: '[{"found":1,"results":[]}]' },
    { action: { tool: 'listing_details', toolInput: '{"number":2}' }, observation: 'not json' }];
  assert.deepEqual(toolCalls(steps), [
    { tool: 'search_listings', input: { request: 'chambre' }, output: { found: 1, results: [] } },
    { tool: 'listing_details', input: { number: 2 }, output: 'not json' }]);
  assert.deepEqual(toolCalls(undefined), []);
});

test('fallback masking when the Text service did not answer', () => {
  assert.equal(fallbackMask('appelez le 22 345 678 ou ali@mail.tn, budget 450'), 'appelez le <PHONE> ou <EMAIL>, budget 450');
  assert.equal(fallbackMask('S+2, 1.225.000 DT'), 'S+2, 1.225.000 DT');          // a price (7 digits) is not a phone
});
