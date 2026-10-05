"""P7 golden set (p7_photos v1, D-082): coverage, labels inside the output vocabulary, sources and licences, blind re-label."""
import json
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
DS = ROOT / "eval" / "datasets"
SCHEMA = json.loads((ROOT / "prompts/schemas/P7_photo_analyzer.v2.schema.json").read_text(encoding="utf-8"))["properties"]
LISTS = ["bed_kinds", "furniture", "appliances", "bathroom_fixtures", "condition_signs"]
SCALARS = ["room_type", "beds", "windows", "natural_light", "condition", "furnished"]
ALLOWED_LICENCES = {"CC0", "Public domain", "CC BY 2.0", "CC BY 3.0", "CC BY 4.0", "CC BY-SA 2.0", "CC BY-SA 3.0", "CC BY-SA 4.0"}


def rows(name="p7_photos_v1.jsonl"):
    return [json.loads(l) for l in (DS / name).read_text(encoding="utf-8").splitlines() if l.strip()]


def test_coverage_spec_9_5():
    r = rows()
    assert len(r) >= 50 and len({x["id"] for x in r}) == len(r) and len({x["sha256"] for x in r}) == len(r)
    groups = Counter(x["tags"][0] for x in r)
    assert set(groups) == {"bedroom", "living", "kitchen", "bathroom", "other", "not_a_room"}
    tags = Counter(t for x in r for t in x["tags"][1:])
    assert tags["people"] >= 3 and tags["text"] >= 3 and tags["dark"] >= 3 and tags["poor_condition"] >= 3


def test_labels_use_the_output_vocabulary():
    for x in rows():
        g = x["gold"]
        for k in LISTS:
            allowed = SCHEMA[k]["items"]["enum"]
            assert set(g.get(k, [])) <= set(allowed) and set(g.get(f"{k}_maybe", [])) <= set(allowed), (x["id"], k)
            assert not set(g.get(k, [])) & set(g.get(f"{k}_maybe", [])), (x["id"], k)
        for k in SCALARS:
            for v in [g[k], *g.get(f"{k}_alt", [])]:
                assert v is None or v == "*" or v in SCHEMA[k]["enum"], (x["id"], k, v)
        assert isinstance(g["readable_text"], bool) and isinstance(g["people_visible"], bool)
        if g["room_type"] == "not_a_room":
            assert all(g[k] == "*" for k in ("beds", "windows", "natural_light", "condition", "furnished")), x["id"]


def test_every_photo_has_an_open_licence_and_a_source():
    for x in rows():
        s = x["source"]
        assert s["licence"] in ALLOWED_LICENCES, (x["id"], s["licence"])
        assert s["page"].startswith("https://commons.wikimedia.org/wiki/File:"), x["id"]
    listed = (DS / "p7_photos_v1_sources.md").read_text(encoding="utf-8")
    assert all(f"| {x['id']} |" in listed for x in rows())


def test_blind_relabel_sample():
    blind, relab = rows("relabel/p7_photos_v1_blind.jsonl"), rows("relabel/p7_photos_v1_relabel.jsonl")
    assert all(set(b) == {"id", "file", "sha256"} for b in blind)               # no labels in what the annotator got
    assert {b["id"] for b in blind} == {r["id"] for r in relab} and len(blind) >= 0.2 * len(rows())
    adj = json.loads((DS / "relabel/p7_photos_v1_adjudication.json").read_text(encoding="utf-8"))
    gold = {x["id"]: x["gold"] for x in rows()}
    for c in adj["changes"]:                                                     # the adjudicated values are the ones stored
        assert gold[c["id"]][c["field"]] == c["after"]["value"], c
