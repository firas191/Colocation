// Re-run HTML extraction offline on the saved raw pages (kb/packs/*/documents/<key>/raw.html,
// written by `scripts/kb.py export`) with the pack's extract options, and compare with the
// stored clean.txt. Shows which documents a change to kb/lib/text.js or to sources.csv will
// change at the next ingestion, before running it.
//   node kb/tools/reextract.js [packs_dir] [path/to/text.js]
// Output: one line per document: same | changed (+chars) | error.
const fs = require('fs');
const path = require('path');
const packs = process.argv[2] || path.join(__dirname, '..', 'packs');
const T = require(path.resolve(process.argv[3] || path.join(__dirname, '..', 'lib', 'text.js')));

function parseCsv(text) {               // RFC 4180: quoted fields, doubled quotes, CRLF or LF
  const rows = []; let row = [], f = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c; continue; }
    if (c === '"') q = true; else if (c === ',') { row.push(f); f = ''; }
    else if (c === '\n') { row.push(f.replace(/\r$/, '')); rows.push(row); row = []; f = ''; } else f += c;
  }
  if (f || row.length) { row.push(f); rows.push(row); }
  const [h, ...rest] = rows;
  return rest.filter((r) => r.length > 1).map((r) => Object.fromEntries(h.map((k, i) => [k, r[i] || ''])));
}

let changed = 0;
for (const pack of fs.readdirSync(packs).sort()) {
  const csv = path.join(packs, pack, 'sources.csv');
  if (!fs.existsSync(csv)) continue;
  for (const s of parseCsv(fs.readFileSync(csv, 'utf8'))) {
    const dir = path.join(packs, pack, 'documents', s.source_key);
    const raw = path.join(dir, 'raw.html');
    if (!fs.existsSync(raw) || !fs.existsSync(path.join(dir, 'clean.txt'))) continue;
    const meta = fs.existsSync(path.join(dir, 'meta.json')) ? JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8')) : {};
    const f = s.extract ? JSON.parse(s.extract) : {};
    const stored = fs.readFileSync(path.join(dir, 'clean.txt'), 'utf8').replace(/\n$/, '');
    try {
      const dec = T.decodeBytes(fs.readFileSync(raw), meta.content_type || 'text/html');
      let text = T.htmlToText(dec.text, { select: f.select || [], keepBoilerplate: !!f.keep_boilerplate }).text;
      if (f.start_at || f.end_at) text = T.cutBetween(text, f.start_at, f.end_at).text;
      const same = text === stored;
      if (!same) changed++;
      console.log(`${same ? 'same   ' : 'changed'}  ${s.source_key.padEnd(34)} ${stored.length} -> ${text.length} chars`);
    } catch (e) {
      changed++;
      console.log(`error    ${s.source_key.padEnd(34)} ${e.message}`);
    }
  }
}
console.log(`${changed} document(s) would change`);
