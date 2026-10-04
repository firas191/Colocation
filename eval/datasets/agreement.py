"""Agreement between the labels of a golden set and a blind re-label of a sample (spec 9.5:
re-label a random 20% without looking at the first labels and report the agreement).

    python eval/datasets/agreement.py p1_router_v1   # or p2_profile_v1

Reads <name>.jsonl (first labels) and relabel/<name>_relabel.jsonl (second labels, made from
relabel/<name>_blind.jsonl, which holds only id, message and context). Prints per-field
agreement, Cohen's kappa for the P1 intent, and every disagreement; writes
relabel/<name>_agreement.json.
"""
from __future__ import annotations

import json
import sys
from collections import Counter
from pathlib import Path

HERE = Path(__file__).resolve().parent


def load(p: Path) -> dict:
    return {r["id"]: r for r in (json.loads(l) for l in p.read_text(encoding="utf-8").splitlines() if l.strip())}


def kappa(a: list, b: list) -> float:
    n = len(a)
    po = sum(x == y for x, y in zip(a, b)) / n
    ca, cb = Counter(a), Counter(b)
    pe = sum(ca[k] * cb[k] for k in set(a) | set(b)) / (n * n)
    return 1.0 if pe == 1 else (po - pe) / (1 - pe)


def fields_p1(g: dict) -> dict:
    return {"intent": g["intent"], "acceptable_intents": sorted(g["acceptable_intents"]), "language": g["language"],
            "script": g["script"], "jurisdiction_hint": g["jurisdiction_hint"],
            "needs_clarification": g["needs_clarification"]}


def fields_p2(g: dict) -> dict:
    p = g["profile"]
    out = {k: p[k] for k in ("jurisdiction_code", "budget_min_minor", "budget_max_minor", "currency", "budget_period",
                             "anchor_label", "max_commute_min", "move_in_from", "min_stay_months")}
    out["anchor_label"] = (p["anchor_label"] or "").strip().lower() or None
    out["declared_preferences"] = json.dumps(p["declared_preferences"], sort_keys=True)
    out["languages"] = sorted(p["languages"])
    out["must_not_map (non-empty)"] = bool(g.get("must_not_map"))
    return out


def main(name: str):
    first = load(HERE / f"{name}.jsonl")
    second = load(HERE / "relabel" / f"{name}_relabel.jsonl")
    fx = fields_p1 if name.startswith("p1") else fields_p2
    ids = sorted(second)
    per, disagreements = {}, []
    for i in ids:
        a, b = fx(first[i]["gold"]), fx(second[i]["gold"])
        for k in a:
            per.setdefault(k, [0, 0])
            per[k][1] += 1
            if a[k] == b[k]:
                per[k][0] += 1
            else:
                disagreements.append({"id": i, "field": k, "first": a[k], "second": b[k], "message": first[i]["message"]})
    out = {"dataset": name, "items": len(ids), "of": len(first),
           "agreement": {k: {"agree": v[0], "n": v[1], "rate": round(v[0] / v[1], 3)} for k, v in per.items()},
           "items_fully_agreeing": sum(all(fx(first[i]["gold"])[k] == fx(second[i]["gold"])[k] for k in per) for i in ids)}
    if name.startswith("p1"):
        out["intent_kappa"] = round(kappa([first[i]["gold"]["intent"] for i in ids], [second[i]["gold"]["intent"] for i in ids]), 3)
    out["disagreements"] = disagreements
    (HERE / "relabel" / f"{name}_agreement.json").write_text(json.dumps(out, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    print(f"{name}: {len(ids)} of {len(first)} items re-labelled blind; {out['items_fully_agreeing']} agree on every field")
    for k, v in out["agreement"].items():
        print(f"  {k:28s} {v['agree']:3d}/{v['n']:<3d} {v['rate']:.3f}")
    if "intent_kappa" in out:
        print(f"  intent Cohen's kappa          {out['intent_kappa']:.3f}")
    for d in disagreements:
        print(f"  - {d['id']} {d['field']}: {d['first']!r} vs {d['second']!r}  | {d['message'][:110]}")


if __name__ == "__main__":
    main(sys.argv[1])
