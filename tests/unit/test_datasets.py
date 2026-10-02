"""Static checks of the evaluation datasets (eval/datasets). Whether the gold quotes resolve
against the stored documents is checked by `scripts/kb.py check-gold` on the stack."""
import csv
import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
DS = ROOT / "eval" / "datasets"
TAGS = {"arabizi", "code_switch", "contradiction", "abstain", "cross_lingual"}


def pack_keys():
    keys = {}
    for p in (ROOT / "kb" / "packs").iterdir():
        if (p / "sources.csv").exists():
            for r in csv.DictReader((p / "sources.csv").open(encoding="utf-8")):
                keys[r["source_key"]] = p.name
    return keys


def test_manifest_and_queries_are_consistent():
    keys = pack_keys()
    for d in json.loads((DS / "manifest.json").read_text(encoding="utf-8")):
        lines = [json.loads(l) for l in (DS / d["file"]).read_text(encoding="utf-8").splitlines() if l.strip()]
        ids = [q["id"] for q in lines]
        assert len(ids) == len(set(ids)) >= 40
        for q in lines:
            assert q["query"].strip() and q["jurisdiction"] == "TN", q["id"]
            assert set(q["tags"]) <= TAGS, q["id"]
            spans = q["gold"]["spans"]
            assert ("abstain" in q["tags"]) == (not spans), q["id"]          # out of scope <=> no gold
            if "contradiction" in q["tags"]:
                assert len({s["source_key"] for s in spans}) >= 2, q["id"]    # every side is listed
            for s in spans:
                assert keys.get(s["source_key"]) in ("TN", "GLOBAL"), (q["id"], s["source_key"])
                assert s["start"] and s["end"], q["id"]


def test_dataset_file_is_what_its_builder_writes(tmp_path):
    out = tmp_path / "built.jsonl"                     # the repository is read-only in the tests container
    subprocess.run([sys.executable, str(DS / "build_tn_retrieval_v1.py"), str(out)], check=True, capture_output=True)
    assert out.read_bytes() == (DS / "tn_retrieval_v1.jsonl").read_bytes()
