// A3 Match agent checks (D-084): n8n/src/lib/agent_check.js
const test = require('node:test');
const assert = require('node:assert/strict');
const { toolCalls, readings, checkAnswer, fallbackMask, plainText, shorten } = require('../src/lib/agent_check.js');

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

test('Markdown becomes plain text on one line (D-085)', () => {
  const md = 'Voici 10 résultats :\n\n*   **Résultat 2** : Chambre à Ariana, 340 DT/mois.\n- _calme_ et [proche](http://x.tn)\n## Fin';
  assert.equal(plainText(md), 'Voici 10 résultats : Résultat 2 : Chambre à Ariana, 340 DT/mois. calme et proche Fin');
  assert.equal(plainText('S+2 à 450 DT, 2 * 3 chambres, prix_max'), 'S+2 à 450 DT, 2 * 3 chambres, prix_max');   // not Markdown
  assert.equal(plainText('1. Ennasr\n2. La Marsa'), 'Ennasr La Marsa');
});

test('a long answer is cut at the last sentence that fits (D-085)', () => {
  const t = 'Trois annonces trouvées. La 1 est à Ennasr pour 400 DT. La 2 est plus loin mais moins chère.';
  assert.deepEqual(shorten(t, 200), { text: t, cut: false });
  assert.deepEqual(shorten(t, 60), { text: 'Trois annonces trouvées. La 1 est à Ennasr pour 400 DT.', cut: true });
  assert.deepEqual(shorten('Une seule phrase très longue sans point final qui continue encore', 30),
    { text: 'Une seule phrase très longue\u2026', cut: true });
  assert.equal(shorten('وجدت 3 إعلانات. الأول في النصر بـ 400 دينار. الثاني أبعد.', 45).text, 'وجدت 3 إعلانات. الأول في النصر بـ 400 دينار.');
});
