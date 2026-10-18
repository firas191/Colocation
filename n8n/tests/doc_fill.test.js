// Document templates (D-108): n8n/src/lib/doc_fill.js and kb/templates/*/*.json
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { templatesFor, checkValues, renderHtml, NOTICE } = require('../src/lib/doc_fill.js');

const root = path.join(__dirname, '..', '..', 'kb', 'templates');
const all = fs.readdirSync(root).filter((d) => fs.statSync(path.join(root, d)).isDirectory())
  .flatMap((d) => fs.readdirSync(path.join(root, d)).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(fs.readFileSync(path.join(root, d, f), 'utf8'))));

test('every template is complete: languages, slots used are declared, legal ones have dated sources', () => {
  assert.ok(all.length >= 6);
  for (const t of all) {
    for (const l of t.languages) {
      assert.ok(t.text[l] && t.text[l].title && t.text[l].paragraphs.length, `${t.key} ${l}`);
      for (const p of t.text[l].paragraphs) for (const m of p.matchAll(/\{\{\s*([a-z_]+)\s*\}\}/g)) {
        assert.ok(t.slots.some((s) => s.name === m[1]), `${t.key} ${l}: ${m[1]} is not a slot`);
      }
    }
    if (t.legal) {
      assert.ok(t.sources.length > 0, `${t.key} has no source`);
      for (const s of t.sources) assert.match(s.retrieved_at, /^\d{4}-\d{2}-\d{2}$/) && assert.match(s.url, /^https:\/\//);
    }
  }
});

test('a country gets only the types it has sources for, plus the house rules and the living plan', () => {
  const kinds = (j) => templatesFor(all, j).map((t) => t.kind).sort();
  assert.deepEqual(kinds('TN'), ['flatmate_agreement', 'house_rules', 'inventory_entry', 'inventory_exit', 'living_plan', 'rent_receipt']);
  assert.deepEqual(kinds('GB'), ['house_rules', 'living_plan', 'rent_receipt']);
  assert.deepEqual(kinds('FR'), ['house_rules', 'living_plan']);
});

test('living plan (D-115): agreements and costs as tables, chores in words, an empty table and its heading left out', () => {
  const lp = all.find((t) => t.key === 'global.living_plan');
  const c = checkValues(lp, { household: 'Dar Yasmine', start_date: '2026-11-01',
    habits: [{ topic: 'Tabac', agreement: "D'accord : non" }, { topic: 'Animaux', agreement: 'À discuter : les réponses diffèrent' }],
    costs: [{ label: 'Loyer', amount: '900.000 TND', due_day: '5', share: '450.000 TND' }], chores: [{ title: 'Vaisselle', frequency: 'weekly', next: '2026-11-03' }],
    rules: [] }, ctx);
  assert.deepEqual(c.missing, []);
  const html = renderHtml(lp, 'fr', c.values, { country: 'Tunisie', generated_on: '2026-10-18', notice_version: 'v1' });
  for (const s of ["D'accord : non", '450.000 TND', 'chaque semaine', 'Vaisselle', 'à partir du 2026-11-01', 'Plan de vie commune du foyer Dar Yasmine.']) assert.ok(html.includes(s.replace("'", '&#39;')), s);
  assert.ok(!html.includes('Règles de la maison'), 'no rules: no heading');
  assert.ok(!html.includes('Remarques'), 'no notes: no line');
  assert.deepEqual(checkValues(lp, { household: 'X' }, ctx).missing, ['habits']);
  const noDate = renderHtml(lp, 'en', checkValues(lp, { household: 'Dar Y', habits: [{ topic: 'Pets', agreement: 'Agreed: no' }] }, ctx).values,
    { country: 'Tunisia', generated_on: '2026-10-18', notice_version: 'v1' });
  assert.ok(noDate.includes('Living plan of the household Dar Y.') && !noDate.includes('applies from'), 'no start date: only that line goes');
});

const tn = (k) => all.find((t) => t.key === `tn.${k}`);
const ctx = { exponent: 3, currency: 'TND' };

test('missing slots are listed, unknown slots dropped, bad values refused', () => {
  const r = checkValues(tn('rent_receipt'), { landlord: 'Omar', tenant: 'Amel', amount: 450000, period: '2026-13', paid_on: '2026-11-03',
    secret_clause: 'Le locataire renonce à tout recours' }, ctx);
  assert.deepEqual(r.missing.sort(), ['address', 'confirmed_on', 'period']);
  assert.deepEqual(r.dropped, ['secret_clause']);
  assert.equal(r.values.amount, '450.000 TND');
  assert.equal(checkValues(tn('flatmate_agreement'), { notice_days: 400 }, ctx).missing.includes('notice_days'), true);
});

test('the PDF text is the template text with the values, and nothing else (diff against the template)', () => {
  const t = tn('inventory_entry');
  const values = { occupants: 'Amel, Bilel', address: '12 rue <b>X</b>', date: '2026-11-01',
    items: [{ room: 'Chambre', item: 'Lit', condition: 'bon', notes: '<script>alert(1)</script>' }] };
  const c = checkValues(t, values, ctx);
  assert.deepEqual(c.missing, []);
  const html = renderHtml(t, 'fr', c.values, { country: 'Tunisie', generated_on: '2026-11-01', notice_version: 'documents-notice-v1' });
  assert.ok(!html.includes('<script>') && html.includes('&lt;script&gt;') && !html.includes('<b>X</b>'));
  const text = (h) => h.replace(/<style[\s\S]*?<\/style>/, '').replace(/<title>[\s\S]*?<\/title>/, '').replace(/<[^>]+>/g, ' ')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
  const ws = (x) => x.replace(/\s+/g, ' ');
  let rest = ws(text(html));
  const fr = t.text.fr;
  const pieces = [fr.title, 'Pays: Tunisie · Modèle: tn.inventory_entry v1 · Établi le 2026-11-01',
    ...fr.paragraphs.filter((p) => p !== '{{items}}').map((p) => p.replace(/\{\{(\w+)\}\}/g, (m, k) => c.values[k])),
    'Pièce', 'Élément', 'État', 'Remarques', 'Chambre', 'Lit', 'bon', '<script>alert(1)</script>',
    'Sources (lues le)', ...t.sources.map((s) => `${s.cite_as}: ${s.title}. ${s.publisher}. ${s.url} (${s.retrieved_at})`),
    `${NOTICE.fr} (documents-notice-v1)`];
  for (const p0 of pieces) {
    const p = ws(p0);
    assert.ok(rest.includes(p), `missing: ${p}`);
    rest = rest.replace(p, ' ');
  }
  assert.equal(rest.trim(), '', `text outside the template: ${rest.trim().slice(0, 200)}`);
});

test('Arabic is laid out right to left; an empty optional slot leaves its paragraph out', () => {
  const t = tn('flatmate_agreement');
  const c = checkValues(t, { flatmates: 'أمل، بلال', address: 'تونس', start_date: '2026-11-01', notice_days: 30,
    shares: [{ name: 'أمل', share: '225 د' }] }, ctx);
  const html = renderHtml(t, 'ar', c.values, { country: 'تونس', generated_on: '2026-11-01', notice_version: 'documents-notice-v1' });
  assert.match(html, /<html lang="ar" dir="rtl">/);
  assert.ok(!html.includes('قواعد المنزل:'), 'no rules given: the rules paragraph is left out');
});
