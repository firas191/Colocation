// Reads kb/packs/<code>/scam_phrases.csv (signal,lang,pattern,note; quoted fields may hold commas). Used by the unit
// tests; n8n/build_platform.py reads the same files and writes the rows into the Code nodes at build time.
function parseCsv(text) {
  const rows = [];
  let row = [];
  let cur = '';
  let q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { cur += '"'; i++; } else if (c === '"') q = false; else cur += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(cur); cur = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cur); cur = '';
      if (row.some((x) => x !== '')) rows.push(row);
      row = [];
    } else cur += c;
  }
  if (cur !== '' || row.length) { row.push(cur); rows.push(row); }
  return rows;
}

function readPhrases(root, fs) {
  const out = [];
  for (const pack of fs.readdirSync(root).sort()) {
    const f = `${root}/${pack}/scam_phrases.csv`;
    if (!fs.existsSync(f)) continue;
    const [head, ...lines] = parseCsv(fs.readFileSync(f, 'utf8'));
    for (const l of lines) out.push({ pack, ...Object.fromEntries(head.map((h, i) => [h, l[i] || ''])) });
  }
  return out;
}

if (typeof module !== 'undefined') module.exports = { parseCsv, readPhrases };
