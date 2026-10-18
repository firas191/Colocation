// lib/flatmate_profile.js (D-115, T-84): the profile agent's proposal checked by code, and the match sentence.
const test = require('node:test');
const assert = require('node:assert/strict');
const { checkProposal, supportedByText, twoQuestions, checkSentence, codeSentence } = require('../src/lib/flatmate_profile.js');

test('checkProposal keeps known fields with valid values only', () => {
  const r = checkProposal({ lifestyle: { smoking: 'NO', pets: 'maybe', colour: 'blue' }, budget_max: '450', seeking: 'room', visible: 'true' });
  assert.deepEqual(r.values, { lifestyle: { smoking: 'no' }, budget_max: 450, seeking: 'room', visible: true });
  assert.deepEqual(r.errors.map((e) => e.field), ['lifestyle.pets', 'lifestyle.colour']);
});

test('supportedByText drops an amount or a place the person did not write', () => {
  const r = supportedByText({ budget_max: 999, areas: ['La Marsa', 'Carthage'] }, ['Une chambre à La Marsa, 450 dt maximum']);
  assert.deepEqual(r.values, { areas: ['La Marsa'] });
  assert.deepEqual(r.dropped.map((d) => d.field), ['budget_max', 'areas']);
  assert.deepEqual(supportedByText({ budget_max: 450 }, ['450.000 DT']).values, { budget_max: 450 });
});

test('twoQuestions cuts after the second question', () => {
  assert.deepEqual(twoQuestions('Noté. Où cherchez-vous ? Quel budget ? Et vos horaires ?'), { text: 'Noté. Où cherchez-vous ? Quel budget ?', cut: true });
  assert.deepEqual(twoQuestions('أين تبحث؟ ما ميزانيتك؟ هل تدخن؟'), { text: 'أين تبحث؟ ما ميزانيتك؟', cut: true });
  assert.deepEqual(twoQuestions('Où cherchez-vous ? Quel budget ?'), { text: 'Où cherchez-vous ? Quel budget ?', cut: false });
  assert.deepEqual(twoQuestions('Enregistré.'), { text: 'Enregistré.', cut: false });
});

test('the match sentence: code writes it, and a model sentence with another number is refused', () => {
  const c = { score: 60, factors: [{ factor: 'smoking', state: 'match' }, { factor: 'pets', state: 'differs' }] };
  assert.equal(codeSentence(c, 'fr'), 'Vous vous accordez sur : le tabac. À discuter : les animaux.');
  assert.equal(checkSentence('Score de 60 : vous êtes d’accord sur le tabac.', c, 'fr').ok, true);
  assert.equal(checkSentence('Vous êtes compatibles à 42 %, surtout sur le tabac.', c, 'fr').ok, false);
  assert.equal(checkSentence('Vous vous accordez sur le budget et le tabac.', c, 'fr').why, 'topic_not_given:budget');
});
