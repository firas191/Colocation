// Trust check rules (D-107): n8n/src/lib/trust_rules.js and the phrase lists kb/packs/*/scam_phrases.csv
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { compilePhrases, scanText, checkAgent, messageCodes } = require('../src/lib/trust_rules.js');
const { readPhrases } = require('../src/lib/trust_phrases_csv.js');

const root = path.join(__dirname, '..', '..', 'kb', 'packs');
const rows = readPhrases(root, fs);
const phrases = compilePhrases(rows);
const scan = (t, j = 'TN') => scanText(t, phrases, ['GLOBAL', j]).map((x) => x.signal).sort();

test('every line of every list compiles', () => {
  assert.ok(rows.length >= 15);
  assert.equal(phrases.length, rows.length);
  for (const r of rows) assert.ok(['payment_before_viewing', 'untraceable_payment', 'urgency_pressure', 'owner_abroad',
    'discriminatory_language'].includes(r.signal), r.signal);
});

test('scam wording is found in French, English, Arabic and Tunisian', () => {
  assert.deepEqual(scan("Je suis à l'étranger, envoyez la caution par Western Union avant la visite."),
    ['owner_abroad', 'payment_before_viewing', 'untraceable_payment']);
  assert.deepEqual(scan('Please send the deposit before the viewing, many people are interested.'),
    ['payment_before_viewing', 'urgency_pressure']);
  assert.deepEqual(scan('ادفع العربون قبل الزيارة'), ['payment_before_viewing']);
  assert.deepEqual(scan('5alles 9bal ma tchouf, ena fel 5arej'), ['owner_abroad', 'payment_before_viewing']);
  assert.deepEqual(scan('Paiement par mandat minute uniquement'), ['untraceable_payment']);
  assert.deepEqual(scan('Paiement par mandat minute uniquement', 'FR'), [], 'the TN list applies to TN only');
});

test('ordinary listings find nothing', () => {
  for (const t of ['Chambre meublée à Lac 2, 450 DT par mois, caution un mois, visite le samedi.',
    'Room in a quiet flat, bills included, deposit one month paid at the signature.',
    'غرفة مفروشة قرب الجامعة، الإيجار 400 دينار شهريا',
    'Propriétaire en France mais mon frère fait les visites sur place.',
    "Rien n'est payé avant la visite et la signature.", 'لا شيء يدفع قبل الزيارة']) {
    assert.deepEqual(scan(t).filter((s) => s !== 'owner_abroad'), [], t);
  }
});

test("the agent's signals need a quote from the text, and a payment needs a rule too", () => {
  const text = "Je suis à l'étranger. Réservez vite, il faut payer avant la visite.";
  const rules = scanText(text, phrases, ['GLOBAL', 'TN']);
  const raw = 'Voici: {"signals": [' +
    '{"signal": "owner_abroad", "points": -10, "evidence_quote": "Je suis à l\'étranger", "confidence": 0.9},' +
    '{"signal": "payment_before_viewing", "points": -40, "evidence_quote": "payer avant la visite"},' +
    '{"signal": "untraceable_payment", "points": -30, "evidence_quote": "western union"},' +
    '{"signal": "made_up", "points": -50, "evidence_quote": "Réservez vite"}], "summary": "x"}';
  const r = checkAgent(raw, text, rules);
  assert.equal(r.parsed, true);
  assert.deepEqual(r.kept.map((x) => x.signal), ['owner_abroad', 'payment_before_viewing']);
  assert.deepEqual(r.dropped.map((x) => x.why), ['quote_not_in_text', 'unknown_signal']);
  const alone = checkAgent('{"signals": [{"signal": "payment_before_viewing", "evidence_quote": "Réservez vite"}]}', text, []);
  assert.equal(alone.kept[0].signal, 'payment_claim_unconfirmed', 'without the rule it cannot be a hard signal');
  assert.equal(checkAgent('not json', text, rules).parsed, false);
});

test('message warnings: payment and pressure only', () => {
  assert.deepEqual(messageCodes('Envoie 200 DT par Western Union avant de visiter', phrases, ['GLOBAL', 'TN']).sort(),
    ['payment_before_viewing', 'untraceable_payment']);
  assert.deepEqual(messageCodes('Mon numéro est le 22 333 444, je suis en France', phrases, ['GLOBAL', 'TN']), []);
});
