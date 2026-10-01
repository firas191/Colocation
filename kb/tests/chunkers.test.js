// Unit tests for kb/lib/tokens.js and the chunkers.  Run: node --test kb/tests/
const test = require('node:test');
const assert = require('node:assert/strict');
const TOK = require('../lib/tokens.js');
const TXT = require('../lib/text.js');
Object.assign(global, TOK, TXT);          // structure_aware.js uses these as globals, as in a Code node
const { parseStructure, articleRef } = require('../chunkers/structure.js');
const { chunkFixed } = require('../chunkers/fixed.js');
const { chunkStructureAware } = require('../chunkers/structure_aware.js');

// Stand-in tokenizer for tests: one token per run of non-space characters.
const wordTokens = (s) => [...s.matchAll(/\S+/g)].map((m) => [m.index, m.index + m[0].length]);

test('splitPieces cuts at whitespace and covers the text exactly', () => {
  const s = 'aaaa bbbb cccc dddd\neeee ffff';
  const p = TOK.splitPieces(s, 10);
  assert.equal(p.map((x) => x.text).join(''), s);
  for (const x of p) assert.ok(x.text.length <= 10);
  assert.ok(p.slice(1).every((x) => /^[ \n]/.test(x.text)));
});

test('pieceOffsets converts UTF-8 byte offsets and trims leading spaces', () => {
  const piece = { start: 100, text: ' الكراء عقد' };
  // byte offsets as a Rust tokenizer would give them, with the space included in the first token
  const toks = [{ id: 1, start: 0, stop: 13, special: false }, { id: 2, start: 13, stop: 20, special: false },
    { id: 0, start: null, stop: null, special: true }];
  const r = TOK.pieceOffsets(piece, toks);
  assert.equal(r.unit, 'byte');
  assert.deepEqual(r.offsets, [[101, 107], [108, 111]]);
  const c = TOK.pieceOffsets({ start: 0, text: 'été chaud' }, [{ start: 0, stop: 3 }, { start: 3, stop: 9 }]);
  assert.equal(c.unit, 'char');
  assert.deepEqual(c.offsets, [[0, 3], [4, 9]]);
});

test('countTokens counts tokens fully inside a span', () => {
  const s = 'un deux trois quatre';
  const t = wordTokens(s);
  assert.equal(TOK.countTokens(t, 0, s.length), 4);
  assert.equal(TOK.countTokens(t, 3, 13), 2);
  assert.equal(TOK.countTokens(t, 4, 13), 1);      // "deux" starts at 3: not fully inside
});

test('strategy A: 500/50 windows, exact spans, last window ends at the last token', () => {
  const words = Array.from({ length: 1234 }, (_, i) => `w${i}`);
  const s = words.join(' ');
  const t = wordTokens(s);
  const c = chunkFixed(s, t, { size: 500, overlap: 50 });
  assert.deepEqual(c.map((x) => x.token_count), [500, 500, 334]);
  assert.equal(s.slice(c[1].start_char, c[1].end_char).split(' ')[0], 'w450');
  assert.equal(c[2].end_char, s.length);
  assert.equal(chunkFixed('', [], {}).length, 0);
  assert.throws(() => chunkFixed(s, t, { size: 10, overlap: 10 }));
});

const CODE = [
  'LIVRE DEUXIEME', 'DES DIVERS CONTRATS', '',
  'TITRE PREMIER', 'DU LOUAGE', '',
  'Article 727', 'Le louage de choses est un contrat par lequel une partie cède la jouissance d\'une chose.', '',
  'Article 728', 'Le louage se parfait par le consentement des parties.', '',
  'Art. 729 bis - Le preneur doit payer le prix.', '',
  'TITRE DEUXIEME', 'DU DEPOT', '',
  'Article 1000', 'Le dépôt est un contrat.',
].join('\n');

test('structure: headings with folded titles, articles, heading paths', () => {
  const st = parseStructure(CODE);
  assert.deepEqual(st.headings.map((h) => [h.level, h.label]),
    [[1, 'LIVRE DEUXIEME - DES DIVERS CONTRATS'], [2, 'TITRE PREMIER - DU LOUAGE'], [2, 'TITRE DEUXIEME - DU DEPOT']]);
  assert.deepEqual(st.units.map((u) => [u.kind, u.ref, u.path]),
    [['article', '727', [0, 1]], ['article', '728', [0, 1]], ['article', '729 bis', [0, 1]], ['article', '1000', [0, 2]]]);
  assert.ok(CODE.slice(st.units[0].start, st.units[0].end).startsWith('Article 727\nLe louage'));
});

test('structure: Arabic articles and markdown headings', () => {
  assert.equal(articleRef('الفصل 727 ـ الكراء عقد'), '727');
  assert.equal(articleRef('الفصل الأول'), '1');
  assert.equal(articleRef('الفصل ٧٢٨'), '728');
  assert.equal(articleRef('Article premier : objet'), '1');
  assert.equal(articleRef('Articles généraux du code'), null);
  const st = parseStructure('# Guide\n\nIntro texte.\n\n## Dépôt\n\nLe dépôt est rendu.\n\nSecond paragraphe.');
  assert.deepEqual(st.units.map((u) => [u.kind, u.path.map((i) => st.headings[i].label)]),
    [['para', ['Guide']], ['para', ['Guide', 'Dépôt']], ['para', ['Guide', 'Dépôt']]]);
});

test('strategy B: small articles merged under the same title, never across titles; refs and embed text', () => {
  const t = wordTokens(CODE);
  const c = chunkStructureAware(CODE, t, parseStructure(CODE), { maxTokens: 400, minTokens: 150, citeAs: 'COC' });
  assert.equal(c.length, 2);
  assert.equal(c[0].article_ref, 'COC art. 727-729 bis');
  assert.deepEqual(c[0].heading_path, ['LIVRE DEUXIEME - DES DIVERS CONTRATS', 'TITRE PREMIER - DU LOUAGE']);
  assert.equal(c[1].article_ref, 'COC art. 1000');
  assert.ok(c[0].metadata.embed_text.startsWith('LIVRE DEUXIEME - DES DIVERS CONTRATS > TITRE PREMIER - DU LOUAGE\nArticle 727'));
  assert.equal(c[0].metadata.merged_units, 3);
  for (let i = 1; i < c.length; i++) assert.ok(c[i].start_char >= c[i - 1].end_char, 'no overlap');
});

test('strategy B: a long article is split at sentence boundaries, every piece within the limit', () => {
  const sentence = (i) => `Phrase numero ${i} qui contient plusieurs mots pour remplir le texte.`;
  const body = Array.from({ length: 120 }, (_, i) => sentence(i)).join(' ');
  const doc = `Article 1\n${body}\n\nArticle 2\nCourt.`;
  const t = wordTokens(doc);
  const c = chunkStructureAware(doc, t, parseStructure(doc), { maxTokens: 400, minTokens: 150 });
  const first = c.filter((x) => x.article_ref && x.article_ref.startsWith('art. 1'));
  assert.ok(first.length >= 3);
  for (const x of c) assert.ok(x.token_count <= 400, `chunk of ${x.token_count} tokens`);
  for (const x of first.slice(1)) assert.match(doc.slice(x.start_char, x.end_char), /^Phrase numero \d+/);
  assert.deepEqual(first[0].metadata.parts.slice(0, 1), ['1 1/' + first[0].metadata.parts[0].split('/')[1]]);
});

test('strategy B: one sentence longer than the limit is cut into token windows', () => {
  const doc = 'Article 9\n' + Array.from({ length: 950 }, (_, i) => `m${i}`).join(' ');
  const t = wordTokens(doc);
  const c = chunkStructureAware(doc, t, parseStructure(doc), { maxTokens: 400, minTokens: 150 });
  assert.deepEqual(c.map((x) => x.token_count), [400, 400, 152]);
  assert.equal(c[2].end_char, doc.length);
});
