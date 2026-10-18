// Notification texts for e-mail and Telegram (D-110): n8n/src/lib/notify_text.js with the website's sentences
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { formatMessage, notificationText, notificationPath } = require('../src/lib/notify_text.js');

const texts = Object.fromEntries(['fr', 'en', 'ar'].map((l) => [l,
  JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'web', 'messages', `${l}.json`), 'utf8')).notifications.types]));

test('plain values, plural with #, =0 and select', () => {
  assert.equal(formatMessage('Bonjour {name}.', { name: 'Amel' }, 'fr'), 'Bonjour Amel.');
  const p = '{count, plural, =0 {rien} one {# annonce} other {# annonces}}';
  assert.equal(formatMessage(p, { count: 0 }, 'fr'), 'rien');
  assert.equal(formatMessage(p, { count: 1 }, 'fr'), '1 annonce');
  assert.equal(formatMessage(p, { count: 3 }, 'fr'), '3 annonces');
  assert.equal(formatMessage('{d, select, owe {vous devez} other {on vous doit}}', { d: 'owe' }, 'fr'), 'vous devez');
  assert.equal(formatMessage('{n, plural, one {واحد} two {اثنان} few {# قليل} other {# كثير}}', { n: 2 }, 'ar'), 'اثنان');
});

test('every notification type of the website has a sentence in each language, and they all format', () => {
  for (const l of ['fr', 'en', 'ar']) {
    assert.deepEqual(Object.keys(texts[l]).sort(), Object.keys(texts.fr).sort(), l);
    for (const k of Object.keys(texts[l])) {
      const out = notificationText(texts, k, { title: 'T', name: 'N', count: 2, from: 'F', on: '2027-01-01', due_on: '2027-01-01' }, l);
      assert.ok(out && !/[{}]/.test(out), `${l} ${k}: ${out}`);
    }
  }
  assert.match(notificationText(texts, 'saved_search_match', { count: 2, name: 'Tunis' }, 'fr'), /2 nouvelles annonces/);
  assert.equal(notificationText(texts, 'no_such_type', {}, 'fr'), null);
});

test('links follow the website pages', () => {
  assert.equal(notificationPath('conversation', 'abc'), '/messages/abc');
  assert.equal(notificationPath('saved_search', 'x'), '/saved-searches');
  assert.equal(notificationPath(null, null), '/notifications');
});
