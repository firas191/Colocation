// Unit tests for kb/lib/text.js and kb/lib/robots.js.  Run: node --test kb/tests/ eval/tests/
const test = require('node:test');
const assert = require('node:assert/strict');
const T = require('../lib/text.js');
const R = require('../lib/robots.js');

test('normalizeText: NFKC, NBSP, zero-width, soft hyphen, blank lines', () => {
  const s = 'Loyer :  500​ DT\r\n\r\n\r\n\r\nﻻ  بأس­\n';
  assert.equal(T.normalizeText(s), 'Loyer : 500 DT\n\nلا بأس');
});

test('htmlToText: headings, paragraphs, lists, entities; scripts and nav dropped', () => {
  const html = `<html><head><title>x</title><style>p{}</style></head><body>
    <nav><a href="/">Accueil</a> | <a>Menu</a></nav>
    <h1>Du louage</h1><p>Le bail est&nbsp;un contrat&#8230; <b>important</b>.</p>
    <script>var secret = 1;</script>
    <ul><li>un</li><li>deux &amp; trois</li></ul>
    <h3></h3>
    <footer>© 2026 site</footer></body></html>`;
  const { text } = T.htmlToText(html);
  assert.equal(text, '# Du louage\n\nLe bail est un contrat... important.\n\n- un\n- deux & trois');
});

test('htmlToText: select a container by id, nested same tags balanced', () => {
  const html = '<div id="menu">Menu</div><div id="content"><div class="a">Article 1</div><div>Texte</div></div><div>Pied</div>';
  const r = T.htmlToText(html, { select: [{ tag: 'div', id: 'content' }] });
  assert.equal(r.selected, true);
  assert.equal(r.text, 'Article 1\n\nTexte');
  const miss = T.htmlToText(html, { select: { id: 'nope' } });
  assert.equal(miss.selected, false);
  assert.match(miss.text, /Menu/);
});

test('decodeBytes: charset from header, from meta, default utf-8', () => {
  const latin = Buffer.from([0x4c, 0x6f, 0x79, 0x65, 0x72, 0x20, 0xe9, 0x74, 0xe9]); // "Loyer été" in windows-1252
  assert.equal(T.decodeBytes(latin, 'text/html; charset=windows-1252').text, 'Loyer été');
  const meta = Buffer.concat([Buffer.from('<meta charset="iso-8859-1">'), latin]);
  assert.match(T.decodeBytes(meta, 'text/html').text, /Loyer été$/);
  assert.equal(T.decodeBytes(Buffer.from('الكراء'), '').text, 'الكراء');
  assert.throws(() => T.decodeBytes(Buffer.from('x'), 'text/html; charset=not-a-charset'), /unsupported charset/);
});

test('pdfPagesToText: running header/footer and page numbers removed, wrapped lines joined', () => {
  const page = (n, body) => `CODE DES OBLIGATIONS\n${body}\nPage ${n}`;
  const pages = [
    page(1, 'Article 727\nLe louage de choses est un contrat par lequel une des parties cède à l\'autre la jouissance\nd\'une chose pour un certain temps, moyennant un prix.'),
    page(2, 'Article 728\nLe louage se parfait par le consentement des parties sur la chose, sur le prix et sur les\nautres clauses du contrat.'),
    page(3, 'Article 729\nOn peut donner à loyer les choses mobilières ou immo-\nbilières.'),
  ];
  const r = T.pdfPagesToText(pages);
  assert.equal(r.pages, 3);
  assert.doesNotMatch(r.text, /CODE DES OBLIGATIONS|Page \d/);
  assert.match(r.text, /cède à l'autre la jouissance d'une chose pour un certain temps/);
  assert.match(r.text, /immobilières\./);
  assert.match(r.text, /^Article 727\n\nLe louage/);
});

test('sentenceStarts: abbreviations, numbers and lower-case continuations are not boundaries', () => {
  const s = 'Voir l\'art. 727 du code. Le prix est de 1.500 dinars. Il est payé d\'avance! Puis ceci? Oui.';
  const starts = T.sentenceStarts(s).map((i) => s.slice(i, i + 6));
  assert.deepEqual(starts, ['Le pri', 'Il est', 'Puis c', 'Oui.']);
  const ar = 'يجب دفع الكراء. هل يمكن الكراء؟ نعم.';
  assert.deepEqual(T.sentenceStarts(ar).map((i) => ar.slice(i, i + 3)), ['هل ', 'نعم']);
});

test('robots: specific group beats *, longest rule wins, Allow wins a tie, wildcards', () => {
  const txt = `User-agent: *\nDisallow: /private\nAllow: /private/ok\nDisallow: /*.pdf$\n\nUser-agent: FlatshareKB\nUser-agent: other\nDisallow: /blocked\n`;
  const g = R.parseRobots(txt);
  assert.equal(g.length, 2);
  const ua = 'FlatshareKB/0.2 (+student project)';
  assert.equal(R.robotsAllowed(g, ua, '/private/x').allowed, true);       // our group has no /private rule
  assert.equal(R.robotsAllowed(g, ua, '/blocked/page').allowed, false);
  const other = 'SomeBot/1.0';
  assert.equal(R.robotsAllowed(g, other, '/private/x').allowed, false);
  assert.equal(R.robotsAllowed(g, other, '/private/ok/1').allowed, true);
  assert.equal(R.robotsAllowed(g, other, '/doc/a.pdf').allowed, false);
  assert.equal(R.robotsAllowed(g, other, '/doc/a.pdf?x=1').allowed, true);
  const tie = R.parseRobots('User-agent: *\nDisallow: /a\nAllow: /a\n');
  assert.equal(R.robotsAllowed(tie, other, '/a/b').allowed, true);
  assert.equal(R.robotsAllowed(R.parseRobots('User-agent: *\nDisallow:\n'), other, '/x').allowed, true);
});

test('robots: decisions from the HTTP status (RFC 9309)', () => {
  const ua = 'FlatshareKB/0.2';
  assert.deepEqual(R.robotsDecision(404, '', ua, 'https://x.tn/a').allowed, true);
  assert.equal(R.robotsDecision(503, '', ua, 'https://x.tn/a').allowed, false);
  assert.equal(R.robotsDecision(0, '', ua, 'https://x.tn/a').reason, 'robots_unreachable');
  const d = R.robotsDecision(200, 'User-agent: *\nDisallow: /fr/\n', ua, 'https://x.tn/fr/code?id=1');
  assert.equal(d.allowed, false);
  assert.equal(d.rule, 'disallow /fr/');
});

test('splitUrl: scheme, host, path and query without the URL class', () => {
  assert.deepEqual(R.splitUrl('https://www.ins.tn/sites/a%20b.pdf?x=1#f'),
    { protocol: 'https:', host: 'www.ins.tn', pathname: '/sites/a%20b.pdf', search: '?x=1' });
  assert.deepEqual(R.splitUrl('http://h:8081'), { protocol: 'http:', host: 'h:8081', pathname: '/', search: '' });
  assert.equal(R.splitUrl('ftp://x/y'), null);
  assert.equal(R.robotsDecision(200, '', 'UA', 'file:///etc/passwd').allowed, false);
});

test('decodeBytes: windows-1256 and iso-8859-6 decoded from tables, without ICU (F-029)', () => {
  const real = global.TextDecoder;
  global.TextDecoder = class { constructor(l) { if (l !== 'utf-8') throw new RangeError('no ICU: ' + l); return new real(l); } };
  try {
    const fixture = require('node:fs').readFileSync(require('node:path').join(__dirname, '../../tests/fixtures/kb/law_ar.html'));
    const r = T.decodeBytes(fixture, 'text/html');
    assert.equal(r.charset, 'windows-1256');
    assert.match(r.text, /يدفع المكتري معين الكراء/);
    assert.ok(!r.text.includes('\ufffd'));
    // "الكراء" in ISO-8859-6
    assert.equal(T.decodeBytes(Buffer.from([0xc7, 0xe4, 0xe3, 0xd1, 0xc7, 0xc1]), 'text/plain; charset=iso-8859-6').text, 'الكراء');
    assert.equal(T.decodeBytes(Buffer.from([0x80, 0xe9]), 'text/html; charset=ISO-8859-1').text, '€é');
  } finally {
    global.TextDecoder = real;
  }
});

test('normalizeText removes characters outside the BMP so JS and PostgreSQL offsets agree (F-030)', () => {
  const t = T.normalizeText('Arnaque \u{1F6A8} évitée \u{1F44D}! Fin');
  assert.equal(t, 'Arnaque évitée ! Fin');
  assert.equal([...t].length, t.length);              // one UTF-16 unit per code point
  assert.equal(T.normalizeText('a\ud800b'), 'ab');     // lone surrogate dropped
});

test('htmlToText drops struck-through (repealed) wording', () => {
  const { text } = T.htmlToText('<p>Le délai est de <del>deux</del><strike>deux</strike><s>2</s> trois mois.</p>');
  assert.equal(text, 'Le délai est de trois mois.');
});

test('cutBetween keeps the article between markers; missing start fails, missing end keeps the rest', () => {
  const t = 'Menu\nAccueil\n# Titre\n\nTexte utile.\n\nLIRE AUSSI\nautre';
  assert.deepEqual(T.cutBetween(t, '# Titre', 'LIRE AUSSI'), { text: '# Titre\n\nTexte utile.', ended: true });
  assert.deepEqual(T.cutBetween(t, null, 'LIRE AUSSI'), { text: 'Menu\nAccueil\n# Titre\n\nTexte utile.', ended: true });
  assert.equal(T.cutBetween(t, '# Titre', 'ABSENT').ended, false);
  assert.throws(() => T.cutBetween(t, 'ABSENT', null), /start marker not found/);
});

test('decodeBytes: header says utf-8, bytes are windows-1256 as the meta says (F-032, Caddy/Go default header)', () => {
  const fixture = require('node:fs').readFileSync(require('node:path').join(__dirname, '../../tests/fixtures/kb/law_ar.html'));
  const r = T.decodeBytes(fixture, 'text/html; charset=utf-8');
  assert.equal(r.charset, 'windows-1256');
  assert.equal(r.source, 'meta');
  assert.ok(r.invalid_bytes > 0);
  assert.match(r.note, /declared utf-8 \(header\)/);
  assert.match(r.text, /يدفع المكتري معين الكراء/);
  assert.ok(!r.text.includes('�'));
});

test('decodeBytes: UTF-8 page with a Latin-1 template keeps the UTF-8 text, stray bytes read as windows-1252 (F-032)', () => {
  // as on jurisitetunisie.com: comments saved in Latin-1, content in UTF-8, both declarations utf-8
  const latin = (s) => Buffer.from(s, 'latin1');
  const buf = Buffer.concat([Buffer.from('<meta charset="utf-8"><!-- Ajout'), latin('\xe9'), Buffer.from(' 2023 -->'),
    Buffer.from('<p>Le preneur doit payer le loyer aux termes convenus. Ã défaut, voilà la règle: dépôt, échéance.</p>')]);
  const r = T.decodeBytes(buf, 'text/html; charset=utf-8');
  assert.equal(r.charset, 'utf-8+windows-1252');
  assert.equal(r.invalid_bytes, 1);
  assert.match(r.text, /Ajouté 2023/);
  assert.match(r.text, /voilà la règle: dépôt, échéance/);
  assert.ok(!r.text.includes('�'));
});

test('decodeBytes: valid UTF-8 untouched; mostly-invalid bytes with only utf-8 declared fail (F-032)', () => {
  const ok = T.decodeBytes(Buffer.from('<p>été ✓ الكراء</p>'), 'text/html; charset=utf-8');
  assert.deepEqual([ok.charset, ok.invalid_bytes, ok.text], ['utf-8', 0, '<p>été ✓ الكراء</p>']);
  const allLatin = Buffer.from('<p>d\xe9p\xf4t \xe0 r\xe9gler \xe9ch\xe9ance</p>', 'latin1');
  assert.throws(() => T.decodeBytes(allLatin, 'text/html; charset=utf-8'), /decoding_failed utf-8 \(header\): 6 invalid bytes and 0 valid/);
  // no declaration at all
  assert.throws(() => T.decodeBytes(allLatin, 'text/html'), /decoding_failed utf-8 \(default\)/);
});

test('utf8Scan follows RFC 3629: overlong forms, surrogates and > U+10FFFF are invalid', () => {
  assert.deepEqual(T.utf8Scan(Buffer.from('aé€𝄞')), { multibyte: 3, invalid: 0 });
  assert.equal(T.utf8Scan(Buffer.from([0xc0, 0xaf])).invalid, 2);               // overlong "/"
  assert.equal(T.utf8Scan(Buffer.from([0xed, 0xa0, 0x80])).invalid, 3);         // UTF-16 surrogate
  assert.equal(T.utf8Scan(Buffer.from([0xf4, 0x90, 0x80, 0x80])).invalid, 4);   // above U+10FFFF
  assert.equal(T.utf8Scan(Buffer.from([0xe2, 0x82])).invalid, 2);               // truncated
});

test('decodeBytes: Latin-1 bytes inside HTML comments do not count against a short UTF-8 page (F-036)', () => {
  // tn-coc-jurisite-739: 24 Latin-1 bytes in template comments, one in an attribute, few accents in the text
  const latin = (x) => Buffer.from(x, 'latin1');
  const comments = Array.from({ length: 23 }, () => Buffer.concat([Buffer.from('<!-- ajout'), latin('\xe9'), Buffer.from(' -->')]));
  const buf = Buffer.concat([Buffer.from('<meta charset="utf-8">'), ...comments,
    Buffer.from('<img alt="L'), latin('\xe9'), Buffer.from('gislation">'),
    Buffer.from('<p>Article 739 - Le preneur est tenu de payer le loyer. Il répond des dégâts.</p>')]);
  assert.deepEqual(T.utf8Scan(buf), { multibyte: 3, invalid: 24 });
  assert.deepEqual(T.utf8Scan(buf, true), { multibyte: 3, invalid: 1 });
  const r = T.decodeBytes(buf, 'text/html; charset=utf-8');
  assert.equal(r.charset, 'utf-8+windows-1252');
  assert.equal(r.note, '1 of 24 invalid bytes outside HTML comments');
  assert.match(r.text, /Il répond des dégâts\./);
  assert.match(r.text, /alt="Législation"/);
});

test('htmlToText: a ">" inside a quoted attribute does not end the tag (F-037)', () => {
  // as on wrcati.cawtar.org: a tooltip attribute holding HTML
  const html = `<p>أركان <acronym onMouseOver="return overlib('العقد هو اتفاق', CAPTION, '<center>Contrat<center>', LEFT);" onMouseOut="return nd(1);">العقد</acronym> الذي يترتب عليه</p><p title='a > b'>Fin</p>`;
  assert.equal(T.htmlToText(html).text, 'أركان العقد الذي يترتب عليه\n\nFin');
  const sel = T.htmlToText(`<div data-x="<b>" id="content"><p>Texte</p></div><div>Menu</div>`, { select: { id: 'content' } });
  assert.deepEqual([sel.selected, sel.text], [true, 'Texte']);
});

test('scriptProblem: Latin-looking garbage from an Arabic PDF without Unicode fonts is caught (F-038)', () => {
  const garbage = '‘ngW¬*Kr33∂h4_rS¡ƒ ct`sn V`Lst<(8_∫ΩtDLd_∫sd$ ±L8_∫b3 ÷±a∫nh_∫2` cXS∫nc*L ‘ngX_∫sƒnld _∫2t ƒƒ*<s∫r33wj<gru∫';
  assert.match(T.scriptProblem(garbage, 'ar'), /symbol characters/);
  assert.equal(T.scriptProblem('الفصل 772 للمكتري أن يكري لغيره ما اكتراه (art. 772 COC)', 'ar'), null);
  assert.equal(T.scriptProblem('Le preneur a le droit de sous-louer, à moins que la défense...', 'fr'), null);
  assert.match(T.scriptProblem('للمكتري أن يكري لغيره ما اكتراه أو يحيل عقد كرائه', 'fr'), /Latin letters in a fr source/);
  assert.equal(T.scriptProblem('', 'fr'), 'no letters in the extracted text');
});

test('htmlToText: a <br> inside a heading does not split it (F-039)', () => {
  const html = '<h2 class="t">Titre<br>III : Du louage</h2><h4>Des<br/>effets du louage des choses</h4><p>Art. 739. - Le bailleur<br>est tenu.</p>';
  assert.equal(T.htmlToText(html).text, '## Titre III : Du louage\n\n#### Des effets du louage des choses\n\nArt. 739. - Le bailleur\nest tenu.');
});

test('htmlToText: source line breaks are spaces, <pre> keeps them (F-039)', () => {
  const html = '<h2>Titre \n    III : Du louage</h2>\n<p>Le preneur doit restituer la chose ; il doit le prix à dire\nd\'experts.</p><pre>ligne 1\nligne 2</pre>';
  assert.equal(T.htmlToText(html).text, "## Titre III : Du louage\n\nLe preneur doit restituer la chose ; il doit le prix à dire d'experts.\n\nligne 1\nligne 2");
});
