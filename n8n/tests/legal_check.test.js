// A5 Legal agent checks (D-087): n8n/src/lib/legal_check.js
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseLegal, markers, renumber, stripMarkers, uncited } = require('../src/lib/legal_check.js');

test('the tokens for no answer and for disagreeing sources are read and removed', () => {
  assert.deepEqual(parseLegal('[NOT_FOUND] Les extraits ne parlent pas du préavis.'),
    { notFound: true, conflict: false, text: 'Les extraits ne parlent pas du préavis.' });
  assert.deepEqual(parseLegal('[CONFLICT] La loi dit A [1]. Un blog dit B [2].'),
    { notFound: false, conflict: true, text: 'La loi dit A [1]. Un blog dit B [2].' });
  assert.equal(parseLegal('NOT_FOUND: rien.').notFound, true);              // without brackets, at the start
  assert.equal(parseLegal('Réponse [1]. [CONFLICT]').conflict, true);        // anywhere, removed
  assert.equal(parseLegal('Réponse [1]. [CONFLICT]').text, 'Réponse [1].');
  assert.equal(parseLegal('Le bailleur rend la caution [1].').notFound, false);
  assert.equal(parseLegal('Il rend la caution. [1] Le bail est écrit.[2][3] Fin').text, 'Il rend la caution [1]. Le bail est écrit [2][3]. Fin');
});

test('citation markers are read in all their forms', () => {
  assert.deepEqual(markers('A [1]. B [2, 3]. C [1][4]; D [ 5 ].'), [1, 2, 3, 1, 4, 5]);
  assert.deepEqual(markers('article 729 du code'), []);
});

test('markers are kept only for excerpts the search gave, and renumbered by first use', () => {
  const r = renumber('Le bail est écrit [3]. La caution est rendue [5, 9]. Voir [3].', [1, 2, 3, 4, 5]);
  assert.equal(r.text, 'Le bail est écrit [1]. La caution est rendue [2]. Voir [1].');
  assert.deepEqual(r.used, [3, 5]);
  assert.deepEqual(r.invalid, [9]);
  const none = renumber('Le délai est de deux mois [7].', [1, 2]);
  assert.equal(none.text, 'Le délai est de deux mois.');
  assert.deepEqual(none.used, []);
});

test('markers are not numbers of the answer, and uncited sentences are counted', () => {
  assert.equal(stripMarkers('Le préavis est de 3 mois [12].'), 'Le préavis est de 3 mois .');
  assert.equal(uncited('Le bail doit être écrit [1]. Le bailleur doit aussi rendre la caution. Oui.'), 1);
  assert.equal(uncited('الضمان يرجع عند انتهاء الكراء [1]. هذا كل شيء في النص.'), 1);
});
