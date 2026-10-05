#!/usr/bin/env python3
"""Evaluates the Text service (D-074, D-075).

  pii     recall and precision of masking on eval/datasets/pii_v1.jsonl (spec 2.6: recall >= 0.98)
  langid  language and script accuracy on the P1 golden set (labels from eval/datasets/guides/p1_router.md)
          and, as a second set, the P2 golden set's language tags

Calls the running service (--url, X-Internal-Token from INTERNAL_SERVICE_TOKEN) or imports the code (--local).
Writes a JSON report with every item and prints a summary.

Metrics (PII): a gold span counts as masked when every one of its characters is inside some predicted span
(any type): what matters for privacy is that the value is hidden. Type accuracy is reported separately.
A predicted span that overlaps no gold span is a false positive (over-masking). Recall per type and per language.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
DS = ROOT / "eval" / "datasets"


def rows(name):
    return [json.loads(line) for line in (DS / name).read_text(encoding="utf-8").splitlines() if line.strip()]


class Local:
    def __init__(self):
        sys.path[:0] = [str(ROOT / "services" / "text"), str(ROOT / "services" / "common")]
        import langid
        import pii
        self.langid, self.pii = langid, pii

    def mask(self, text, use_ner=True):
        return self.pii.mask(text, use_ner=use_ner)

    def lang(self, text):
        return {**self.langid.identify(text), "backend": self.langid.default_backend().name}


class Remote:
    def __init__(self, url):
        import httpx
        self.c = httpx.Client(base_url=url.rstrip("/"), timeout=60,
                              headers={"X-Internal-Token": os.environ["INTERNAL_SERVICE_TOKEN"]})

    def mask(self, text, use_ner=True):
        r = self.c.post("/v1/pii/mask", json={"text": text, "use_ner": use_ner})
        r.raise_for_status()
        return r.json()

    def lang(self, text):
        r = self.c.post("/v1/lang", json={"text": text})
        r.raise_for_status()
        return r.json()


def eval_pii(svc, use_ner, dataset="pii_v1.jsonl"):
    items, tot, hit, typed = [], Counter(), Counter(), Counter()
    by_lang_t, by_lang_h = Counter(), Counter()
    fp, n_pred, latencies, ner_flags, ner_errors = 0, 0, [], [], set()
    for r in rows(dataset):
        t0 = time.perf_counter()
        out = svc.mask(r["text"], use_ner)
        latencies.append((time.perf_counter() - t0) * 1000)
        pred = out["entities"]
        n_pred += len(pred)
        ner_flags.append(bool(out.get("ner")))
        if out.get("ner_error"):
            ner_errors.add(out["ner_error"])
        res = []
        for g in r["spans"]:
            covered = all(any(p["start"] <= i < p["end"] for p in pred) for i in range(g["start"], g["end"]))
            same = any(p["start"] <= g["start"] and p["end"] >= g["end"] and p["type"] == g["type"] for p in pred)
            tot[g["type"]] += 1
            by_lang_t[r["lang"]] += 1
            if covered:
                hit[g["type"]] += 1
                by_lang_h[r["lang"]] += 1
            if same:
                typed[g["type"]] += 1
            res.append({"type": g["type"], "text": g["text"], "masked": covered, "type_ok": same})
        extra = [p for p in pred if not any(p["start"] < g["end"] and g["start"] < p["end"] for g in r["spans"])]
        fp += len(extra)
        items.append({"id": r["id"], "lang": r["lang"], "masked_text": out["masked_text"], "gold": res,
                      "false_positives": [{"type": p["type"], "text": r["text"][p["start"]:p["end"]], "source": p.get("source")} for p in extra]})
    n = sum(tot.values())
    latencies.sort()
    summary = {
        "dataset": dataset, "items": len(items), "gold_spans": n, "use_ner": use_ner,
        "ner_active": all(ner_flags) if use_ner else False, "ner_errors": sorted(ner_errors),
        "recall_masked": round(sum(hit.values()) / n, 4), "recall_typed": round(sum(typed.values()) / n, 4),
        "precision": round((n_pred - fp) / n_pred, 4) if n_pred else None, "false_positive_spans": fp,
        "negative_items_with_masking": sum(1 for it in items if not it["gold"] and it["false_positives"]),
        "recall_by_type": {k: f"{hit[k]}/{tot[k]}" for k in sorted(tot)},
        "recall_by_language": {k: f"{by_lang_h[k]}/{by_lang_t[k]}" for k in sorted(by_lang_t)},
        "latency_ms_p50": round(latencies[len(latencies) // 2], 1), "latency_ms_p95": round(latencies[int(len(latencies) * 0.95) - 1], 1),
    }
    return summary, items


def eval_langid(svc):
    out = {}
    for name, label in (("p1_router_v1.jsonl", "p1"), ("p2_profile_v1.jsonl", "p2")):
        data = rows(name)
        ok, tot, conf, items, sok = Counter(), Counter(), Counter(), [], 0
        backend = None
        lat = []
        for r in data:
            t0 = time.perf_counter()
            p = svc.lang(r["message"])
            lat.append((time.perf_counter() - t0) * 1000)
            backend = p.get("backend")
            if label == "p1":
                gold, gscript, grp = r["gold"]["language"], r["gold"]["script"], r["tags"][0]
            else:                                      # P2 tags: fr, en, ar, mixed, aeb_latin, aeb_arabic
                grp = next((t for t in r["tags"] if t in ("fr", "en", "ar", "mixed", "aeb_latin", "aeb_arabic")), "other")
                gold = {"aeb_latin": "aeb", "aeb_arabic": "aeb"}.get(grp, grp)
                gscript = None
            tot[grp] += 1
            good = p["language"] == gold
            ok[grp] += good
            if gscript:
                sok += p["script"] == gscript
            if not good:
                conf[f"{gold}->{p['language']}"] += 1
            items.append({"id": r["id"], "gold": gold, "pred": p["language"], "script": p["script"], "method": p.get("method")})
        lat.sort()
        out[label] = {"items": len(data), "backend": backend, "language_accuracy": round(sum(ok.values()) / len(data), 4),
                      "script_accuracy": round(sok / len(data), 4) if label == "p1" else None,
                      "by_group": {k: f"{ok[k]}/{tot[k]}" for k in sorted(tot)}, "confusions": dict(conf.most_common(10)),
                      "latency_ms_p50": round(lat[len(lat) // 2], 1), "items_detail": items}
    return out


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("what", choices=["pii", "langid"])
    g = ap.add_mutually_exclusive_group(required=True)
    g.add_argument("--url")
    g.add_argument("--local", action="store_true")
    ap.add_argument("--no-ner", action="store_true")
    ap.add_argument("--dataset", default="pii_v1.jsonl", help="pii: pii_v1.jsonl or pii_heldout_v1.jsonl")
    ap.add_argument("--label", default="")
    ap.add_argument("--out-dir", default=str(ROOT / "reports" / "eval"))
    a = ap.parse_args()
    svc = Local() if a.local else Remote(a.url)
    stamp = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
    if a.what == "pii":
        summary, items = eval_pii(svc, not a.no_ner, a.dataset)
        report = {"date": stamp, "label": a.label, "summary": summary, "items": items}
        print(json.dumps(summary, indent=1, ensure_ascii=False))
    else:
        res = eval_langid(svc)
        report = {"date": stamp, "label": a.label, **res}
        print(json.dumps({k: {kk: vv for kk, vv in v.items() if kk != "items_detail"} for k, v in res.items()}, indent=1, ensure_ascii=False))
    out = Path(a.out_dir) / f"text-{a.what}-{stamp}.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(report, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"wrote {out}")


if __name__ == "__main__":
    main()
