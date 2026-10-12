// Owner assistant (D-088): n8n/src/lib/owner_change.js and the diff lines of the Telegram channel.
const test = require('node:test');
const assert = require('node:assert/strict');
const { amount, toChanges } = require('../src/lib/owner_change.js');
const { tgDiff } = require('../src/lib/tg_texts.js');

test('amounts as a model may write them', () => {
  assert.equal(amount('400'), 400);
  assert.equal(amount('400 DT'), 400);
  assert.equal(amount('1.225.000'), 1225000);
  assert.equal(amount('450,5'), 450.5);
  assert.equal(amount(''), null);
  assert.equal(amount('beaucoup'), null);
});

test('tool arguments to the PATCH body: empty fields left out', () => {
  assert.deepEqual(toChanges({ listing: '1', rent: '420', deposit: '', furnished: 'oui', bills_included: 'maybe',
    available_from: '2026-11-01', bedrooms: '2', place: ' Ennasr ', add_amenities: 'wifi, Air conditioning',
    remove_amenities: '', house_rules: 'smoking=no, pets: yes, gender=female', remove_photo: '2, 3', status: 'rented' }),
  { rent: 420, furnished: true, available_from: '2026-11-01', bedrooms: 2, place: 'Ennasr',
    amenities_add: ['wifi', 'air_conditioning'], house_rules: { smoking: 'no', pets: 'yes' }, remove_photos: [2, 3],
    status: 'archived' });
  assert.deepEqual(toChanges({ rent: '', available_from: 'demain', status: 'sold' }), {});
});

test('a change as Telegram shows it', () => {
  assert.deepEqual(tgDiff('fr', [{ field: 'rent', before: 350, after: 420, currency: 'TND' },
    { field: 'furnished', before: null, after: true }, { field: 'remove_photos', before: null, after: [2] },
    { field: 'status', before: 'published', after: 'archived' }, { field: 'house_rules', before: {}, after: { smoking: 'no' } }]),
  ['• Loyer : 350 DT → 420 DT', '• Meublé : — → oui', '• Photos retirées : 2', '• Statut : publiée → archivée (plus visible)',
   '• Règles : — → non-fumeur']);
});
