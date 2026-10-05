// Unit tests for n8n/src/lib/tg_texts.js (Telegram channel replies, D-079).  Run: node --test n8n/tests/
const test = require('node:test');
const assert = require('node:assert/strict');
const { T, tgEsc, tgMoney, tgLang, tgApiError, TG_TEXTS, TG_ISSUES, TG_RULES } = require('../src/lib/tg_texts.js');

test('every language has every text, issue and rule', () => {
  const keys = Object.keys(TG_TEXTS.fr).sort();
  for (const l of ['en', 'ar']) assert.deepEqual(Object.keys(TG_TEXTS[l]).sort(), keys, l);
  for (const l of ['en', 'ar']) assert.deepEqual(Object.keys(TG_ISSUES[l]).sort(), Object.keys(TG_ISSUES.fr).sort(), l);
  for (const l of ['en', 'ar']) assert.deepEqual(Object.keys(TG_RULES[l]).sort(), Object.keys(TG_RULES.fr).sort(), l);
});

test('values are escaped for Telegram HTML, raw values only when asked', () => {
  assert.equal(tgEsc('<b>&'), '&lt;b&gt;&amp;');
  assert.equal(T('fr', 'clarify', { q: 'a <script>' }), 'a &lt;script&gt;');
  assert.equal(T('en', 'understood', { _raw: { what: '<i>x</i>' } }), 'I understood: <i>x</i>');
  assert.equal(T('xx', 'accept'), "J'accepte");                         // unknown language: French
});

test('money in main units per currency', () => {
  assert.equal(tgMoney(450000, 'TND'), '450 DT');
  assert.equal(tgMoney(1225500, 'TND'), '1225.5 DT');
  assert.equal(tgMoney(65000, 'EUR'), '650 €');
  assert.equal(tgMoney(17000, 'GBP'), '£170');
  assert.equal(tgMoney(null, 'TND'), null);
});

test('language from Telegram, API errors in plain words', () => {
  assert.equal(tgLang('ar'), 'ar'); assert.equal(tgLang('en-GB'), 'en'); assert.equal(tgLang('de'), 'fr'); assert.equal(tgLang(''), 'fr');
  assert.equal(tgApiError('fr', { status: 200 }), null);
  assert.equal(tgApiError('en', { status: 429, error_code: 'RATE_LIMITED' }), TG_TEXTS.en.rate);
  assert.equal(tgApiError('en', { status: 0, error_code: 'NO_ANSWER' }), TG_TEXTS.en.down);
  assert.equal(tgApiError('fr', { status: 403, error_code: 'CONSENT_REQUIRED' }), TG_TEXTS.fr.consent_needed);
  assert.match(tgApiError('fr', { status: 422, error_code: 'VALIDATION_FAILED' }), /VALIDATION_FAILED/);
});
