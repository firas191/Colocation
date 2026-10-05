"""Prompt registry files, output schemas and the P1/P2/P3 golden sets (phases 3 and 4)."""
import json
import random
import shutil
import subprocess
import sys
from collections import Counter
from pathlib import Path

import pytest
from jsonschema import Draft202012Validator

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts"))
import prompts  # noqa: E402

DS = ROOT / "eval" / "datasets"
S1 = json.loads((ROOT / "prompts/schemas/P1_router.schema.json").read_text(encoding="utf-8"))
S2 = json.loads((ROOT / "prompts/schemas/P2_profile_extractor.schema.json").read_text(encoding="utf-8"))
S3 = json.loads((ROOT / "prompts/schemas/P3_listing_extractor.schema.json").read_text(encoding="utf-8"))


def rows(name):
    return [json.loads(l) for l in (DS / name).read_text(encoding="utf-8").splitlines() if l.strip()]


def test_prompt_files_pass_the_registry_check():
    assert prompts.check() == []


def test_few_shot_examples_are_not_golden_items():
    """Examples in the templates must not leak golden-set messages (the score would be inflated)."""
    msgs = {r["message"] for n in ("p1_router_v1.jsonl", "p2_profile_v1.jsonl", "p3_listing_v1.jsonl") for r in rows(n)}
    for p in prompts.all_prompts():
        for v in p["versions"]:
            for m in msgs:
                assert m not in v["template"], (v["file"], m[:60])


def test_gold_labels_validate_against_the_output_schemas():
    v1, v2 = Draft202012Validator(S1), Draft202012Validator(S2)
    for r in rows("p1_router_v1.jsonl"):
        out = {k: r["gold"][k] for k in ("intent", "language", "script", "jurisdiction_hint", "needs_clarification")}
        out.update(confidence=1.0, clarifying_question=None)
        assert not list(v1.iter_errors(out)), r["id"]
    for r in rows("p2_profile_v1.jsonl"):
        out = {**r["gold"]["profile"], "unparsed": r["gold"]["must_not_map"], "field_confidence": {}}
        assert not list(v2.iter_errors(out)), r["id"]
    v3 = Draft202012Validator(S3)
    for r in rows("p3_listing_v1.jsonl"):
        assert not list(v3.iter_errors({**r["gold"], "issues": [], "field_confidence": {}})), r["id"]
        assert r["gold"]["amenities"] == sorted(r["gold"]["amenities"]), r["id"]


def test_golden_set_coverage():
    p1, p2 = rows("p1_router_v1.jsonl"), rows("p2_profile_v1.jsonl")
    assert len(p1) >= 150 and len(p2) >= 100                                   # spec 9.5
    groups = Counter(r["tags"][0] for r in p1)
    assert len(groups) >= 6 and sum("injection" in r["tags"] for r in p1) >= 15
    assert sum("unit_trap" in r["tags"] for r in p2) >= 20
    assert {r["context"]["jurisdiction"] for r in p2} == {"TN", "FR", "GB"}
    p3 = rows("p3_listing_v1.jsonl")                                          # spec 9.5: 100, 20 unit traps, 20 non-Latin
    assert len(p3) >= 100 and sum("unit_trap" in r["tags"] for r in p3) >= 20
    assert sum(bool(__import__("re").search(r"[\u0600-\u06ff]", r["message"])) for r in p3) >= 20
    assert {r["context"]["jurisdiction"] for r in p3} == {"TN", "FR", "GB"}


def test_relabel_sample_is_blind_and_complete():
    for name in ("p1_router_v1", "p2_profile_v1", "p3_listing_v1"):
        blind = [json.loads(l) for l in (DS / "relabel" / f"{name}_blind.jsonl").read_text(encoding="utf-8").splitlines() if l.strip()]
        relab = [json.loads(l) for l in (DS / "relabel" / f"{name}_relabel.jsonl").read_text(encoding="utf-8").splitlines() if l.strip()]
        total = len(rows(f"{name}.jsonl"))
        assert all(set(b) == {"id", "message", "context"} for b in blind)       # no labels in what the annotator saw
        assert {b["id"] for b in blind} == {r["id"] for r in relab}
        assert len(blind) >= 0.2 * total


@pytest.mark.skipif(not shutil.which("node"), reason="node not installed")
def test_schema_lite_agrees_with_jsonschema():
    """The JS validator used in n8n gives the same verdict as the reference implementation."""
    rng = random.Random(7)
    base1 = {"intent": "search_listings", "language": "fr", "script": "latin", "jurisdiction_hint": None, "confidence": 0.5,
             "needs_clarification": False, "clarifying_question": None}
    base2 = {**rows("p2_profile_v1.jsonl")[0]["gold"]["profile"], "unparsed": [], "field_confidence": {}}
    mutations = [None, 1, 1.5, -3, "x", "", "2026-13-01", "TND", "tnd", [], ["fr"], ["zz"], {}, {"smoking": "no"},
                 {"gender": "f"}, True, 400.0, 10 ** 13]
    cases = []
    base3 = {**rows("p3_listing_v1.jsonl")[0]["gold"], "issues": [], "field_confidence": {}}
    for schema, base in ((S1, base1), (S2, base2), (S3, base3)):
        for k in base:
            for m in mutations:
                cases.append((schema, {**base, k: m}))
        for k in list(base)[:4]:
            cases.append((schema, {kk: vv for kk, vv in base.items() if kk != k}))
        cases.append((schema, {**base, "extra": 1}))
    rng.shuffle(cases)
    expected = [not list(Draft202012Validator(s).iter_errors(v)) for s, v in cases]
    js = ("const {validate} = require(process.argv[1]); const cases = JSON.parse(require('fs').readFileSync(0, 'utf8'));"
          "console.log(JSON.stringify(cases.map(([s, v]) => validate(s, v).length === 0)));")
    out = subprocess.run(["node", "-e", js, str(ROOT / "n8n/src/lib/schema_lite.js")], input=json.dumps(cases),
                         capture_output=True, text=True, check=True).stdout
    got = json.loads(out)
    diffs = [(json.dumps(cases[i][1])[:120], expected[i], got[i]) for i in range(len(cases)) if expected[i] != got[i]]
    assert not diffs, diffs[:5]
    assert len(cases) > 300


def test_p2_v3_has_its_own_schema_with_main_unit_amounts():
    """D-066: from v3 the model gives amounts in main units; v1 and v2 keep the minor-unit schema."""
    p2 = next(p for p in prompts.all_prompts() if p["name"] == "P2_profile_extractor")
    by_v = {v["version"]: v for v in p2["versions"]}
    assert "budget_max_minor" in by_v[2]["output_schema"]["properties"]
    s3 = by_v[3]["output_schema"]["properties"]
    assert "budget_max" in s3 and "budget_max_minor" not in s3
    assert "currency_exponents" not in by_v[3]["template"] and "_minor" not in by_v[3]["template"]
    v = Draft202012Validator(by_v[3]["output_schema"])
    for r in rows("p2_profile_v1.jsonl"):
        g = dict(r["gold"]["profile"])
        exp = {"TND": 3, "EUR": 2, "GBP": 2}.get(g["currency"], 0)
        for k in ("budget_min_minor", "budget_max_minor"):
            x = g.pop(k)
            g[k[:-6]] = None if x is None else x / 10 ** exp
        assert not list(v.iter_errors({**g, "unparsed": [], "field_confidence": {}})), r["id"]


def test_p3_versions_and_examples():
    """P3 v1 is the direct baseline, v2 adds the normalisation rules (spec 9.3); v2's examples are valid outputs."""
    import re
    p3 = next(p for p in prompts.all_prompts() if p["name"] == "P3_listing_extractor")
    by_v = {v["version"]: v for v in p3["versions"]}
    assert set(by_v) == {1, 2, 3, 4}
    assert "millimes" not in by_v[1]["template"] and "millimes" in by_v[2]["template"]
    assert "millimes" not in by_v[3]["template"] and "millimes" in by_v[4]["template"]      # v3 = v1, v4 = v2, short output
    for n in (3, 4):                                                                     # F-058
        assert by_v[n]["params"]["num_predict"] >= 800 and by_v[n]["output_schema"]["properties"]["issues"]["maxItems"] == 3
        assert "compact JSON on one line" in by_v[n]["template"]
    for n in (2, 4):
        v = Draft202012Validator(by_v[n]["output_schema"])
        ex = re.findall(r"-> (\{.*\})\n", by_v[n]["template"])
        assert len(ex) == 6
        for e in ex:
            o = json.loads(e)
            assert not list(v.iter_errors(o)) and o["amenities"] == sorted(o["amenities"])
