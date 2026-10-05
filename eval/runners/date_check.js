// D-083: what the availability-date check (listing_check.dateMentioned) does on P3 answers already scored.
//   node eval/runners/date_check.js <prompts export .json> [dataset .jsonl]
// For every P3 run in a prompts export (scripts/windows/p4.ps1 -Step report), counts the predicted dates the check would
// remove, split by what the scoring said about them: invented (gold null), correct (tp), wrong date (gold set, other value).
// Also checks that the text of every gold date passes the check.
const fs = require('fs');
const path = require('path');
const { dateMentioned } = require(path.join(__dirname, '..', '..', 'n8n', 'src', 'lib', 'listing_check.js'));
const [exportPath, dsPath = path.join(__dirname, '..', 'datasets', 'p3_listing_v1.jsonl')] = process.argv.slice(2);
const ds = Object.fromEntries(fs.readFileSync(dsPath, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).map((r) => [r.id, r]));
const gold = Object.values(ds).filter((r) => r.gold && r.gold.available_from);
const goldKept = gold.filter((r) => dateMentioned(r.message));
console.log(`gold dates: ${gold.length}, text passes the check: ${goldKept.length}` +
  (goldKept.length < gold.length ? ` (fails: ${gold.filter((r) => !dateMentioned(r.message)).map((r) => r.id).join(', ')})` : ''));
const exp = JSON.parse(fs.readFileSync(exportPath, 'utf8'));
for (const run of exp.runs.filter((r) => r.prompt === 'P3_listing_extractor')) {
  const c = { invented: [0, 0, []], tp: [0, 0, []], wrong: [0, 0, []] };   // [answers with a date, removed, ids kept]
  for (const it of run.items) {
    const f = ((it.metrics || {}).fields || {}).available_from;
    if (!f || f.predicted == null) continue;
    const k = f.result === 'invented' ? 'invented' : f.result === 'tp' ? 'tp' : 'wrong';
    c[k][0] += 1;
    if (!dateMentioned((ds[it.id] || {}).message || '')) c[k][1] += 1; else if (k === 'invented') c[k][2].push(it.id);
  }
  console.log(`v${run.version} (${run.dataset}, ${run.started_at.slice(0, 10)}): invented dates ${c.invented[0]}, removed ${c.invented[1]}` +
    (c.invented[2].length ? ` (kept: ${c.invented[2].join(', ')})` : '') +
    `; correct dates ${c.tp[0]}, removed ${c.tp[1]}; other wrong dates ${c.wrong[0]}, removed ${c.wrong[1]}`);
}
