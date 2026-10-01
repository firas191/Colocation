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
  assert.equal(T.decodeBytes(Buffer.from('x'), 'text/html; charset=not-a-charset').charset, 'utf-8');
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
