#!/usr/bin/env python3
"""A5 Legal agent benchmark on the real model (D-087), spec 10.7: the questions of eval/datasets/tn_retrieval_v2.jsonl
sent to POST /v1/assistant/message, one new TN user per question (no memory, no follow-up routing).

Per question: the route (the Legal agent, or another route chosen by the P1 router), answered or abstained and why,
the conflict flag, the citations, the excerpts retrieved, the best similarity, the latency seen by the client.
Gold spans are those of the retrieval set, resolved against the current documents (eval.resolve_gold); a chunk is
relevant when it overlaps a gold span by eval.relevance_overlap of the shorter one (as in RETRIEVAL_EVAL).

Measures (spec 10.7):
  - correct abstention rate: the 4 out-of-scope questions (tag "abstain") the Legal agent abstained on;
  - false abstention rate: answerable questions (with gold) the Legal agent abstained on;
  - conflict raised on the 10 questions tagged "contradiction" (a question with disagreeing sources in the gold);
  - citation precision: cited excerpts that overlap a gold span, over all cited excerpts of answered questions.
    The gold comes from pooled retrieval judgments (D-052): an unjudged excerpt counts as not relevant, so this is a
    lower bound;
  - retrieval: answerable questions whose retrieved excerpts include a gold span (compare with T-21 hit@5);
  - best similarity of answerable and out-of-scope questions, and what thresholds (legal.min_similarity) would have
    done on these recorded values (simulated, not a run with the threshold);
  - latency p50 / p95.
Faithfulness is judged by hand (spec 10.7): a sample of answered questions with their cited excerpts is written to
reports/eval/legal-bench-<stamp>-sample.md for that.

    python scripts/legal_bench.py [--dataset eval/datasets/tn_retrieval_v2.jsonl] [--limit N] [--ids tn-01,tn-45] [--sample 12]

Environment: FS_API_BASE, FS_SECRETS_FILE, FS_TEST_DB_DSN (as scripts/p3.py). Writes reports/eval/legal-bench-*.json.
"""
from __future__ import annotations

import argparse
import json
import math
import random
import sys
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path

import psycopg

sys.path.insert(0, str(Path(__file__).resolve().parent))
import kb  # noqa: E402

ROOT = Path(__file__).resolve().parents[1]


def pct(xs, q):
    xs = sorted(v for v in xs if v is not None)
    return xs[max(0, math.ceil(q / 100 * len(xs)) - 1)] if xs else None


def rate(num, den):
    return {"n": den, "count": num, "rate": round(num / den, 3) if den else None}


def new_user(conn):
    uid = conn.execute("""insert into app.users (external_auth_id, display_name, role, jurisdiction_code)
                          values (%s, 'Legal benchmark', 'user', 'TN') returning id""",
                       (f"local-legal-bench-{uuid.uuid4().hex[:12]}",)).fetchone()[0]
    for purpose in ("terms", "privacy"):
        conn.execute("insert into app.consents (user_id, purpose, granted, policy_version, source) values (%s, %s, true, 'bench', 'script')",
                     (uid, purpose))
    conn.commit()
    return str(uid)


def legal_step(conn, request_id):
    row = conn.execute("""select s.output, s.tool_calls from ai.agent_steps s join ai.executions e on e.id = s.execution_id
                          where e.request_id = %s and s.agent = 'A5_legal_agent' order by s.step_index desc limit 1""",
                       (request_id,)).fetchone()
    return (row[0] or {}, row[1] or []) if row else ({}, [])


def spans(conn, chunk_ids):
    if not chunk_ids:
        return {}
    rows = conn.execute("select id::text, document_id::text, start_char, end_char from kb.chunks where id = any(%s::uuid[])",
                        (list(chunk_ids),)).fetchall()
    return {r[0]: (r[1], r[2], r[3]) for r in rows}


def relevant(span, gold, frac):
    if not span or span[1] is None:
        return False
    doc, s, e = span
    for g in gold:
        if not g.get("found") or g.get("document_id") != doc:
            continue
        ov = max(0, min(e, g["end"]) - max(s, g["start"]))
        if ov > 0 and ov >= frac * min(g["end"] - g["start"], e - s):
            return True
    return False


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--dataset", default=str(ROOT / "eval" / "datasets" / "tn_retrieval_v2.jsonl"))
    ap.add_argument("--limit", type=int)
    ap.add_argument("--ids")
    ap.add_argument("--sample", type=int, default=12, help="answered questions written out for the manual faithfulness check")
    a = ap.parse_args()
    items = [json.loads(l) for l in Path(a.dataset).read_text("utf-8").splitlines() if l.strip()]
    if a.ids:
        keep = set(a.ids.split(","))
        items = [i for i in items if i["id"] in keep]
    items = items[: a.limit]
    c = kb.client()
    c.http.timeout = __import__("httpx").Timeout(600)
    rows = []
    with psycopg.connect(kb.dsn()) as conn:
        cfg = dict(conn.execute("""select key, value from app.settings where key in ('llm.default_model', 'legal.retrieval',
                                   'legal.min_similarity', 'legal.num_ctx', 'eval.relevance_overlap', 'legal.agent_enabled')""").fetchall())
        pv = conn.execute("""select v.version from ai.prompt_versions v join ai.prompts p on p.id = v.prompt_id
                             where p.name = 'P5_legal_answerer' and v.status = 'active'""").fetchone()
        if not pv:
            sys.exit("P5_legal_answerer has no active version: run scripts/prompts.py sync")
        n_src = conn.execute("""select count(*) from kb.sources where status = 'active' and (jurisdiction_code = 'TN' or jurisdiction_code is null)""").fetchone()[0]
        if not n_src:
            sys.exit("no TN or global source in the knowledge base: ingest the TN pack first")
        conn.execute("update app.settings set value = 'true' where key = 'legal.agent_enabled'")
        conn.commit()
        frac = float(cfg.get("eval.relevance_overlap") or 0.5)
        print(f"{len(items)} questions; model {cfg.get('llm.default_model')}; P5 v{pv[0]}; retrieval {cfg.get('legal.retrieval')}; "
              f"min_similarity {cfg.get('legal.min_similarity')}; {n_src} TN and global sources", flush=True)
        t_start = time.perf_counter()
        for it in items:
            uid = new_user(conn)
            gold = conn.execute("select eval.resolve_gold(%s::jsonb)", (json.dumps(it["gold"]),)).fetchone()[0] or []
            t0 = time.perf_counter()
            r = c.call("POST", "/v1/assistant/message", user_id=uid, body={"text": it["query"]})
            ms = round((time.perf_counter() - t0) * 1000, 1)
            body = r.json()
            d = body.get("data") or {}
            tags = it.get("tags") or []
            row = {"id": it["id"], "language": it.get("language"), "tags": tags, "http": r.status_code, "client_ms": ms,
                   "server_ms": (body.get("meta") or {}).get("latency_ms"), "request_id": body.get("request_id"),
                   "error": (body.get("error") or {}).get("code"), "intent": d.get("intent"), "status": d.get("status"),
                   "answerable": bool(gold) and "abstain" not in tags, "gold_spans": len(gold)}
            legal = r.status_code == 200 and d.get("intent") == "legal_question" and d.get("status") in ("answered", "abstained")
            row["route"] = "legal" if legal else ("error" if r.status_code != 200 else "other")
            if legal:
                out, tools = legal_step(conn, body.get("request_id"))
                cited = [x.get("chunk_id") for x in d.get("citations") or [] if x.get("chunk_id")]
                retrieved = [x.get("chunk_id") for x in out.get("retrieved") or [] if x.get("chunk_id")]
                sp = spans(conn, set(cited) | set(retrieved))
                row.update(answer=d.get("answer"), abstained=d.get("abstained"), abstain_reason=d.get("abstain_reason"),
                           conflict=d.get("conflict"), citations=len(cited),
                           cited_relevant=sum(1 for x in cited if relevant(sp.get(x), gold, frac)),
                           retrieved=len(retrieved), retrieved_relevant=sum(1 for x in retrieved if relevant(sp.get(x), gold, frac)),
                           searches=out.get("searches"), best_similarity=out.get("best_similarity"),
                           invalid_citations=out.get("invalid_citations"), uncited_sentences=out.get("uncited_sentences"),
                           raw_chars=out.get("raw_chars"), cut=out.get("cut"), warnings=d.get("warnings"),
                           cited_ids=cited)
            rows.append(row)
            print(f"{it['id']} {row['route']} {row.get('status')} reason={row.get('abstain_reason')} conflict={row.get('conflict')} "
                  f"cited={row.get('citations')} relevant={row.get('cited_relevant')} retrieved_relevant={row.get('retrieved_relevant')} "
                  f"best={row.get('best_similarity')} {ms:.0f} ms", flush=True)
        minutes = round((time.perf_counter() - t_start) / 60, 1)

        legal = [r for r in rows if r["route"] == "legal"]
        ans = [r for r in legal if r["answerable"]]
        oos = [r for r in rows if "abstain" in r["tags"]]
        oos_legal = [r for r in oos if r["route"] == "legal"]
        contra = [r for r in legal if "contradiction" in r["tags"]]
        answered = [r for r in ans if not r["abstained"]]
        reasons = {}
        for r in legal:
            if r["abstained"]:
                reasons[r["abstain_reason"]] = reasons.get(r["abstain_reason"], 0) + 1
        sims_ans = [r["best_similarity"] for r in ans if r.get("best_similarity") is not None]
        sims_oos = [r["best_similarity"] for r in oos_legal if r.get("best_similarity") is not None]
        sim_table = []
        for t in (0.3, 0.35, 0.4, 0.45, 0.5, 0.55, 0.6):
            sim_table.append({"threshold": t, "out_of_scope_below": sum(1 for x in sims_oos if x < t), "out_of_scope": len(sims_oos),
                              "answerable_below": sum(1 for x in sims_ans if x < t), "answerable": len(sims_ans)})
        summary = {
            "date": datetime.now(timezone.utc).isoformat(timespec="seconds"), "model": cfg.get("llm.default_model"),
            "prompt": f"P5_legal_answerer v{pv[0]}", "dataset": Path(a.dataset).name, "questions": len(rows), "minutes": minutes,
            "settings": {k: cfg.get(k) for k in ("legal.retrieval", "legal.min_similarity", "legal.num_ctx")},
            "routes": {k: sum(1 for r in rows if r["route"] == k) for k in ("legal", "other", "error")},
            "other_routes": sorted({f"{r['intent']}/{r['status']}" for r in rows if r["route"] == "other"}),
            "correct_abstention": {"legal_agent": rate(sum(1 for r in oos_legal if r["abstained"]), len(oos_legal)),
                                   "out_of_scope_total": len(oos), "routed_elsewhere": len(oos) - len(oos_legal)},
            "false_abstention": rate(sum(1 for r in ans if r["abstained"]), len(ans)),
            "abstain_reasons": reasons,
            "conflict_raised_on_contradiction": rate(sum(1 for r in contra if r.get("conflict")), len(contra)),
            "conflict_raised_elsewhere": rate(sum(1 for r in legal if r.get("conflict") and "contradiction" not in r["tags"]),
                                              sum(1 for r in legal if "contradiction" not in r["tags"])),
            "citation_precision": rate(sum(r["cited_relevant"] for r in answered), sum(r["citations"] for r in answered)),
            "answered_with_a_relevant_citation": rate(sum(1 for r in answered if r["cited_relevant"] > 0), len(answered)),
            "retrieved_a_gold_span": rate(sum(1 for r in ans if r["retrieved_relevant"] > 0), len(ans)),
            "uncited_sentences": sum(r.get("uncited_sentences") or 0 for r in answered),
            "invalid_citations": sum(r.get("invalid_citations") or 0 for r in legal),
            "best_similarity": {"answerable": {"min": pct(sims_ans, 0), "p10": pct(sims_ans, 10), "p50": pct(sims_ans, 50)},
                                "out_of_scope": sorted(sims_oos),
                                "thresholds_simulated": sim_table},
            "client_ms": {"p50": pct([r["client_ms"] for r in legal], 50), "p95": pct([r["client_ms"] for r in legal], 95),
                          "max": pct([r["client_ms"] for r in legal], 100)},
            "load": "sequential, one question at a time",
        }
        # sample for the manual faithfulness check: the answer with the text of each excerpt it cites
        rnd = random.Random(42)
        sample = rnd.sample(answered, min(a.sample, len(answered)))
        lines = [f"# Legal agent: answers to check by hand ({summary['date']}, {summary['prompt']}, {summary['model']})", "",
                 "For each answer: is every sentence supported by the excerpt it cites? Note supported / partly / not supported.", ""]
        for r in sample:
            q = next(i for i in items if i["id"] == r["id"])
            lines += [f"## {r['id']}", "", f"**Question:** {q['query']}", "", f"**Answer:** {r['answer']}", ""]
            for k, cid in enumerate(r["cited_ids"], 1):
                row = conn.execute("""select s.title, c.content from kb.chunks c join kb.documents d on d.id = c.document_id
                                      join kb.sources s on s.id = d.source_id where c.id = %s""", (cid,)).fetchone()
                if row:
                    lines += [f"[{k}] *{row[0]}*", "", "> " + row[1].replace("\n", "\n> "), ""]
            lines += ["Judgement: ", ""]
    stamp = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
    out = ROOT / "reports" / "eval" / f"legal-bench-{stamp}.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps({"summary": summary, "questions": rows}, ensure_ascii=False, indent=1), encoding="utf-8")
    (out.parent / f"legal-bench-{stamp}-sample.md").write_text("\n".join(lines), encoding="utf-8")
    print(json.dumps({k: v for k, v in summary.items() if k not in ("best_similarity",)}, indent=1, ensure_ascii=False))
    print(json.dumps({"best_similarity": summary["best_similarity"]}, ensure_ascii=False))
    print(f"wrote {out.relative_to(ROOT)} and the sample for the faithfulness check")


if __name__ == "__main__":
    main()
