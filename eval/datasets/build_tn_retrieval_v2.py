"""Build eval/datasets/tn_retrieval_v2.jsonl: gold set v1 plus the passages judged relevant in
the pooled review of the first evaluation (D-052, eval/datasets/README.md).

    python eval/datasets/build_tn_retrieval_v2.py [--texts kb/packs] [--out eval/datasets/tn_retrieval_v2.jsonl]

Inputs:
- tn_retrieval_v1.jsonl: questions and v1 gold (quotes);
- pool_v2/pool_regions.json: every passage in the top 10 of any of the 12 runs of evaluation job
  92e8c6cd, merged where they overlap (source key and character range, no text);
- pool_v2/judgments.json: one judgment per region (relevant, grade, quotes, reason);
- pool_v2/review.json: spans rejected at review, and the groups of questions that ask the same thing;
- the document texts exported by `scripts/kb.py export` (kb/packs/*/documents/<key>/clean.txt), the same
  versions as the evaluation (not committed, D-044).

For each question, the relevant passages are v1's gold, the accepted new spans of the question and of
the other questions of its need group. Overlapping passages of one document are merged into one span,
so a passage is credited once. Quotes of merged or new spans are cut from the text and checked to
resolve exactly as eval.resolve_gold does (start quote found once, end quote first found at the span end).
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]


def load_texts(packs: Path) -> dict[str, str]:
    return {p.parent.name: p.read_text(encoding="utf-8") for p in packs.glob("*/documents/*/clean.txt")}


def resolve(text: str, start: str, end: str):
    """eval.resolve_gold: offsets of the span, or None if not found or ambiguous."""
    s = text.find(start)
    if s < 0 or text.count(start) != 1:
        return None
    e = text.find(end, s)
    return None if e < 0 else (s, e + len(end))


def quotes_for(text: str, s: int, e: int) -> tuple[str, str]:
    """Shortest start quote (>= 40 chars) unique in the text, and shortest end quote (>= 20 chars) whose
    first occurrence after s ends at e."""
    n = 40
    while text.count(text[s:s + n]) != 1:
        n += 10
        if s + n > e:
            raise ValueError(f"no unique start quote at {s}")
    m = 20
    while True:
        q = text[max(s, e - m):e]
        if text.find(q, s) + len(q) == e:
            return text[s:s + n], q
        m += 10
        if e - m < s:
            raise ValueError(f"no end quote for {s}-{e}")


def build(texts: dict[str, str]) -> list[dict]:
    v1 = [json.loads(l) for l in (HERE / "tn_retrieval_v1.jsonl").read_text(encoding="utf-8").splitlines() if l.strip()]
    regions = {r["region_id"]: (q["id"], r) for q in json.loads((HERE / "pool_v2" / "pool_regions.json").read_text(encoding="utf-8"))
               for r in q["regions"]}
    judgments = json.loads((HERE / "pool_v2" / "judgments.json").read_text(encoding="utf-8"))
    review = json.loads((HERE / "pool_v2" / "review.json").read_text(encoding="utf-8"))
    rejected = {(x["region_id"], x["start_prefix"]) for x in review["rejected_spans"]}
    group_of = {qid: g for g in review["need_groups"] for qid in g}

    # accepted new spans per question: (source_key, s, e, grade)
    added: dict[str, list] = {}
    used_rejections = set()
    for j in judgments:
        qid, r = regions[j["region_id"]]
        text = texts[r["source_key"]]
        region = text[r["start"]:r["end"]]
        for sp in j.get("spans", []):
            key = next((k for k in rejected if k[0] == j["region_id"] and sp["start"].startswith(k[1])), None)
            if key:
                used_rejections.add(key)
                continue
            a = region.find(sp["start"])
            b = region.find(sp["end"], a + 1)
            if a < 0 or b < 0:
                raise SystemExit(f"{j['region_id']}: quote not in region")
            added.setdefault(qid, []).append((r["source_key"], r["start"] + a, r["start"] + b + len(sp["end"]), j["grade"]))
    if used_rejections != rejected:
        raise SystemExit(f"review rejections not matched: {rejected - used_rejections}")

    out = []
    for q in v1:
        spans = []        # (source_key, s, e, grade, origin, quotes or None)
        for g in q["gold"]["spans"]:
            pos = resolve(texts[g["source_key"]], g["start"], g["end"])
            if not pos:
                raise SystemExit(f"{q['id']}: v1 gold does not resolve in {g['source_key']}")
            spans.append((g["source_key"], *pos, 2, "v1", (g["start"], g["end"])))
        for member in group_of.get(q["id"], [q["id"]]):
            for (k, s, e, grade) in added.get(member, []):
                spans.append((k, s, e, grade, "pool" if member == q["id"] else f"pool:{member}", None))
            if member != q["id"]:
                for g in next(x for x in v1 if x["id"] == member)["gold"]["spans"]:
                    pos = resolve(texts[g["source_key"]], g["start"], g["end"])
                    spans.append((g["source_key"], *pos, 2, f"v1:{member}", (g["start"], g["end"])))
        # merge overlapping spans of the same document
        spans.sort(key=lambda x: (x[0], x[1], -x[2]))
        merged = []
        for sp in spans:
            if merged and merged[-1][0] == sp[0] and sp[1] < merged[-1][2]:
                m = merged[-1]
                if sp[1:3] == m[1:3]:
                    origin, quotes = m[4], m[5]
                else:
                    origin, quotes = "merged", None
                merged[-1] = (m[0], m[1], max(m[2], sp[2]), max(m[3], sp[3]), origin, quotes)
            else:
                merged.append(sp)
        gold = []
        for k, s, e, grade, origin, quotes in merged:
            st, en = quotes if quotes else quotes_for(texts[k], s, e)
            if resolve(texts[k], st, en) != (s, e):
                raise SystemExit(f"{q['id']}: generated quotes do not resolve for {k} {s}-{e}")
            gold.append({"source_key": k, "start": st, "end": en, "grade": grade, "origin": origin})
        n_v1 = len(q["gold"]["spans"])
        out.append({**q, "gold": {"spans": gold, "note": q["gold"].get("note", ""),
                                  "v1_spans": n_v1, "pooled_from_job": "92e8c6cd-4bb7-4d0c-8142-644e39eec3af"}})
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--texts", default=str(ROOT / "kb" / "packs"))
    ap.add_argument("--out", default=str(HERE / "tn_retrieval_v2.jsonl"))
    a = ap.parse_args()
    rows = build(load_texts(Path(a.texts)))
    with open(a.out, "w", encoding="utf-8", newline="\n") as f:
        for r in rows:
            f.write(json.dumps(r, ensure_ascii=False) + "\n")
    print(f"{len(rows)} questions, {sum(len(r['gold']['spans']) for r in rows)} gold spans -> {a.out}")


if __name__ == "__main__":
    main()
