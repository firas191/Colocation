"""Failure analysis of prompt evaluation runs (spec 9.5: look at the failures before writing the
next version). Reads a dump written by `scripts/p3.py report` (reports/eval/prompts-*.json) and
the golden sets, and prints, for the latest full run of each model and version:

  P1: intent confusions (gold -> predicted), injection items that failed, errors by language group
  P2: unit errors (gold vs predicted budget), protected preferences mapped, fields with most errors

Usage: python eval/runners/prompt_failures.py reports/eval/prompts-<stamp>.json [--model M] [--version N]
"""
import argparse
import json
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def golden(name):
    return {r["id"]: r for r in map(json.loads, (ROOT / "eval" / "datasets" / name).read_text(encoding="utf-8").splitlines()) if r}


def latest(runs, prompt):
    best = {}
    for r in sorted(runs, key=lambda r: r["started_at"]):
        if r["prompt"] == prompt and r["config"].get("items") == r["dataset_items"]:
            best[(r["config"]["model"], r["version"])] = r
    return best


def short(s, n=90):
    s = " ".join(str(s).split())
    return s if len(s) <= n else s[: n - 1] + "…"


def p1(runs, gold, model, version):
    for (m, v), r in sorted(latest(runs, "P1_router").items()):
        if (model and m != model) or (version and v != version):
            continue
        items = r["items"]
        print(f"\n### P1_router v{v} on {m} (run {r['run_id'][:8]}, {len(items)} items)")
        conf = Counter((x["metrics"].get("gold_intent"), x["metrics"].get("predicted_intent")) for x in items if not x["metrics"].get("intent_ok"))
        print("intent confusions (gold -> predicted: count):")
        for (g, p), c in conf.most_common(8):
            print(f"  {g} -> {p}: {c}")
        inj = [x for x in items if x["metrics"].get("injection")]
        bad = [x for x in inj if not x["metrics"].get("injection_pass")]
        print(f"injection items failed: {len(bad)} of {len(inj)}")
        for x in bad:
            o = x.get("output") or {}
            print(f"  {x['id']} gold={gold[x['id']]['gold']['intent']} got={o.get('intent')} | {short(gold[x['id']]['message'])}")
        grp = Counter(x["metrics"].get("group") for x in items if not x["metrics"].get("intent_ok"))
        print("wrong intent by language group:", dict(grp.most_common()))
        lang = Counter((gold[x["id"]]["gold"]["language"], (x.get("output") or {}).get("language")) for x in items if not x["metrics"].get("language_ok"))
        print("language confusions (gold -> predicted):", ", ".join(f"{g}->{p}: {c}" for (g, p), c in lang.most_common(6)))


def p2(runs, gold, model, version):
    for (m, v), r in sorted(latest(runs, "P2_profile_extractor").items()):
        if (model and m != model) or (version and v != version):
            continue
        items = r["items"]
        print(f"\n### P2_profile_extractor v{v} on {m} (run {r['run_id'][:8]}, {len(items)} items)")
        fields = Counter()
        for x in items:
            for f, d in (x["metrics"].get("fields") or {}).items():
                if isinstance(d, dict) and d.get("result") != "tp":
                    key = "declared_preferences" if f.startswith("pref.") else "languages" if f.startswith("lang.") else f
                    fields[(key, d.get("result"))] += 1
        print("field errors (field/result: items):", ", ".join(f"{f}/{k}: {c}" for (f, k), c in fields.most_common(12)))
        ue = [x for x in items if x["metrics"].get("unit_error")]
        print(f"unit errors: {len(ue)} items")
        for x in ue[:10]:
            g, o = gold[x["id"]]["gold"]["profile"], x.get("output") or {}
            print(f"  {x['id']} gold max={g.get('budget_max_minor')} {g.get('currency')} got max={o.get('budget_max_minor')} {o.get('currency')}"
                  f" | {short(gold[x['id']]['message'])}")
        pm = [x for x in items if x["metrics"].get("protected_mapped")]
        print(f"protected preference mapped to a filter: {len(pm)} items")
        for x in pm[:6]:
            print(f"  {x['id']} declared_preferences={json.dumps((x.get('output') or {}).get('declared_preferences'), ensure_ascii=False)}")
        inv = [x for x in items if x["metrics"].get("invented_budget")]
        print(f"invented budget: {len(inv)} items", " ".join(x["id"] for x in inv))
        inval = [x for x in items if not x["metrics"].get("valid")]
        print(f"invalid output: {len(inval)} items", " ".join(x["id"] for x in inval))


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("dump")
    ap.add_argument("--model")
    ap.add_argument("--version", type=int)
    ap.add_argument("--prompt", choices=["P1_router", "P2_profile_extractor"])
    a = ap.parse_args()
    runs = json.loads(Path(a.dump).read_text(encoding="utf-8"))["runs"]
    if a.prompt in (None, "P1_router"):
        p1(runs, golden("p1_router_v1.jsonl"), a.model, a.version)
    if a.prompt in (None, "P2_profile_extractor"):
        p2(runs, golden("p2_profile_v1.jsonl"), a.model, a.version)


if __name__ == "__main__":
    main()
