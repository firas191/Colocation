"""eval/runners/prompt_report.py renders docs/PROMPT_EVAL.md from stored runs (no database here:
runs are built by scoring the golden labels against themselves and a damaged copy with
eval/lib/prompt_metrics.js)."""
import json
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "eval" / "runners"))
import prompt_report  # noqa: E402

JS = r"""
const fs = require('fs');
const m = require(process.argv[1] + '/eval/lib/prompt_metrics.js');
const c = require(process.argv[1] + '/n8n/src/lib/listing_check.js');
const rd = (f) => fs.readFileSync(process.argv[1] + '/eval/datasets/' + f, 'utf8').split('\n').filter(Boolean).map(JSON.parse);
const out = {};
for (const [name, rows, score, summ] of [['P1_router', rd('p1_router_v1.jsonl'), 'scoreP1', 'summarizeP1'],
                                         ['P2_profile_extractor', rd('p2_profile_v1.jsonl'), 'scoreP2', 'summarizeP2'],
                                         ['P3_listing_extractor', rd('p3_listing_v1.jsonl'), 'scoreP3', 'summarizeP3']]) {
  out[name] = {};
  for (const v of [1, 2]) {
    const items = rows.map((r, i) => {
      let o;
      if (name === 'P1_router') { o = { ...r.gold, confidence: 0.9, clarifying_question: null }; delete o.acceptable_intents;
        if (v === 1 && i % 4 === 0) o.intent = 'smalltalk_or_unsupported'; }
      else if (name === 'P3_listing_extractor') { o = { ...r.gold, issues: [], field_confidence: {} };
        if (v === 1 && i % 5 === 0 && o.rent_amount) o.rent_amount = o.rent_amount * 1000; }
      else { o = { ...r.gold.profile, unparsed: r.gold.must_not_map, field_confidence: {} };
        if (v === 1 && i % 5 === 0 && o.budget_max_minor) o.budget_max_minor = o.budget_max_minor / 1000; }
      const met = name === 'P1_router' ? m.scoreP1(o, r.gold, { tags: r.tags })
        : name === 'P3_listing_extractor' ? m.scoreP3(o, c.checkListing(o, { TND: [30, 10000], EUR: [50, 10000], GBP: [50, 10000] }, null), r.gold, r.tags)
        : m.scoreP2(o, r.gold, r.tags);
      return { id: r.id, tags: r.tags, metrics: met, output: o, raw: JSON.stringify(o), latency_ms: 100 + i };
    });
    const s = m[summ](items.map((x) => ({ metrics: x.metrics, tags: x.tags, latency_ms: x.latency_ms, attempts: 1 })));
    out[name][v] = { items, summary: s };
  }
}
console.log(JSON.stringify(out));
"""


@pytest.mark.skipif(not shutil.which("node"), reason="node not installed")
def test_report_renders_tables_and_paired_differences():
    res = json.loads(subprocess.run(["node", "-e", JS, str(ROOT)], capture_output=True, text=True, check=True).stdout)
    runs = []
    for prompt, by_v in res.items():
        n = len(by_v["1"]["items"])
        for v, r in by_v.items():
            runs.append({"run_id": f"{prompt}-{v}-0000", "config": {"model": "m", "items": n, "prompt": prompt, "version": int(v)},
                         "summary": r["summary"], "started_at": "2026-10-02T00:00:00", "finished_at": "2026-10-02T00:01:00",
                         "git_sha": None, "job_id": None, "dataset": "x", "dataset_items": n, "prompt": prompt,
                         "version": int(v), "version_id": None, "changelog": "", "techniques": [], "items": r["items"]})
    # an earlier, broken run of P1 v1 (every answer invalid): superseded by the later run, so its
    # failures must not be counted (the owner's PC report of 2026-10-03 counted them)
    old = dict(runs[0], run_id="P1_router-1-old", started_at="2026-10-01T00:00:00")
    runs.insert(0, old)
    data = {"generated_at": "now", "runs": runs,
            "failures": [{"run_id": "P1_router-1-0000", "category": "wrong_intent", "items": ["p1-001", "p1-005"]},
                         {"run_id": "P1_router-1-old", "category": "format", "items": ["p1-001", "p1-002", "p1-003"]}],
            "models": [], "default_model": "m", "active": {"P1_router": 1}}
    md = prompt_report.render(data)
    assert "| P1_router | m | v1 | wrong_intent | 2 | p1-001, p1-005 |" in md
    assert "| format |" not in md
    assert md.count("| superseded |") == 1
    assert "## P1 router" in md and "## P2 profile extractor" in md
    assert "| m | v2 | 1 | 1 | 1 |" in md                                     # perfect copy: valid, first try, accuracy 1
    line = next(l for l in md.splitlines() if l.startswith("- m, intent accuracy v2 - v1"))
    v1 = res["P1_router"]["1"]["items"]                                     # every fourth item changed to smalltalk in v1
    expected = sum(1 for x in v1 if not x["metrics"]["intent_ok"]) / len(v1)
    assert expected > 0.15 and f"+{expected:.3f}" in line
    line = next(l for l in md.splitlines() if l.startswith("- m, field F1 v2 - v1"))
    assert line.split(":")[1].strip().startswith("+")
    p2v1 = next(l for l in md.splitlines() if l.startswith("| m | v1 |") and "of" in l)
    assert int(p2v1.split("|")[9]) > 0                                      # unit errors counted in v1
    # P3: rents x1000 on every fifth item in v1 are unit errors in the model answer, removed by the range check
    assert "## P3 listing extractor" in md
    sec = md.split("## P3 listing extractor")[1]
    p3v1 = next(l for l in sec.splitlines() if l.startswith("| m | v1 |"))
    cells = [c.strip() for c in p3v1.split("|")]
    n_scaled = sum(1 for i, x in enumerate(res["P3_listing_extractor"]["1"]["items"]) if i % 5 == 0 and x["output"]["rent_amount"])
    assert n_scaled > 10 and cells[10] == str(n_scaled) and cells[11] == "0" and cells[12] == str(n_scaled)
    assert next(l for l in sec.splitlines() if l.startswith("| m | v2 |")).split("|")[7].strip() == "1"
