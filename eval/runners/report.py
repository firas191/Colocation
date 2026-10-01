"""Write docs/RETRIEVAL_EVAL.md from the evaluation runs stored in the database
(spec 10.7: "a script writes docs/RETRIEVAL_EVAL.md"). Every number in the file
comes from eval.runs / eval.results / kb.* rows; nothing is typed by hand.
Hand-written parts (failure explanations, what was tried and dropped) live in
eval/datasets/<dataset>_notes.json and eval/reports/tried.md and are included
verbatim, marked as such.

    python3 eval/runners/report.py --dsn "<libpq dsn>" --job <eval job id> [--out docs/RETRIEVAL_EVAL.md]
"""
from __future__ import annotations

import argparse
import json
import random
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
METRICS = ["hit@1", "hit@3", "hit@5", "hit@10", "recall@5", "recall@10", "mrr", "ndcg@10"]
PRIMARY_METRICS = ["mrr", "recall@5", "ndcg@10", "hit@5"]
SEED = 20261001
RESAMPLES = 2000


def language_group(language: str | None, tags: list[str]) -> str:
    if "arabizi" in tags:
        return "transliterated"
    if "code_switch" in tags:
        return "mixed"
    return {"fr": "French", "en": "English", "ar": "Arabic script"}.get((language or "").split("-")[0], language or "unknown")


def mean(xs):
    xs = [x for x in xs if x is not None]
    return sum(xs) / len(xs) if xs else None


def bootstrap_diff(a: list[float], b: list[float], resamples: int = RESAMPLES, seed: int = SEED):
    """Paired bootstrap of mean(b - a): (point estimate, 2.5th and 97.5th percentiles)."""
    pairs = [(x, y) for x, y in zip(a, b) if x is not None and y is not None]
    if not pairs:
        return None, None, None
    d = [y - x for x, y in pairs]
    rng = random.Random(seed)
    n = len(d)
    stats = sorted(sum(d[rng.randrange(n)] for _ in range(n)) / n for _ in range(resamples))
    lo = stats[int(0.025 * resamples)]
    hi = stats[min(resamples - 1, int(0.975 * resamples))]
    return sum(d) / n, lo, hi


def fmt(x, digits=3):
    return "n/a" if x is None else f"{x:.{digits}f}"


def config_label(c: dict) -> str:
    s = "A fixed_500_50" if c["strategy"] == "fixed_500_50" else "B structure_aware_v1"
    return f"{s} / {c['model']} / {c['mode']}"


def load(conn, job_id: str):
    cur = conn.cursor()
    cur.execute("select id, input, output, status, created_at, finished_at from app.jobs where id = %s", (job_id,))
    job = cur.fetchone()
    if not job:
        raise SystemExit(f"job {job_id} not found")
    cur.execute("""select r.id, r.config, r.summary, r.git_sha, r.started_at, r.finished_at, r.status
                   from eval.runs r where r.job_id = %s order by r.started_at""", (job_id,))
    runs = [dict(zip(["id", "config", "summary", "git_sha", "started_at", "finished_at", "status"], row)) for row in cur.fetchall()]
    cur.execute("""select x.run_id, q.external_id, q.language, q.tags, q.query, x.metrics, x.retrieved
                   from eval.results x join eval.queries q on q.id = x.query_id
                   join eval.runs r on r.id = x.run_id where r.job_id = %s""", (job_id,))
    results = {}
    for run_id, qid, lang, tags, query, metrics, retrieved in cur.fetchall():
        results.setdefault(str(run_id), {})[qid] = {"language": lang, "tags": tags or [], "query": query,
                                                    "metrics": metrics, "retrieved": retrieved}
    jur = job[1]["jurisdiction"]
    # the corpus the evaluation searched: the jurisdiction's sources plus the global ones
    cur.execute("""select s.source_key, s.source_type, s.reliability, s.language, s.jurisdiction_code,
                          d.char_count, d.version, d.extractor, s.retrieved_at
                   from kb.sources s join kb.documents d on d.source_id = s.id and d.status = 'current'
                   where s.status = 'active' and (s.jurisdiction_code = %s or s.jurisdiction_code is null)
                   order by s.source_key""", (jur,))
    docs = cur.fetchall()
    cur.execute("""select c.strategy, count(*), avg(c.token_count), stddev_pop(c.token_count),
                          min(c.token_count), max(c.token_count)
                   from kb.chunks c join kb.documents d on d.id = c.document_id and d.status = 'current'
                   join kb.sources s on s.id = d.source_id
                   where s.status = 'active' and (s.jurisdiction_code = %s or s.jurisdiction_code is null)
                   group by 1 order by 1""", (jur,))
    chunks = cur.fetchall()
    cur.execute("select name, endpoint, revision, query_prefix, passage_prefix from ai.models where kind = 'embedding' order by name")
    models = cur.fetchall()
    cur.execute("select s.source_key, l.status, l.step, l.detail->>'error' from kb.ingest_log l join kb.sources s on s.id = l.source_id "
                "where l.id in (select max(id) from kb.ingest_log group by source_id) and s.status = 'active' "
                "and (s.jurisdiction_code = %s or s.jurisdiction_code is null) order by 1", (jur,))
    last_ingest = cur.fetchall()
    return job, runs, results, docs, chunks, models, last_ingest


def render(job, runs, results, docs, chunks, models, last_ingest, notes: dict, tried: str) -> str:
    job_id, jinput, _out, jstatus, created, finished = job
    L = []
    w = L.append
    w("# Retrieval evaluation")
    w("")
    w("Generated by `eval/runners/report.py` from the database; do not edit by hand. "
      "Hand-written parts are marked and come from `eval/datasets/*_notes.json` and `eval/reports/tried.md`.")
    w("")
    w(f"- Evaluation job: `{job_id}` ({jstatus}), started {created:%Y-%m-%d %H:%M} UTC, finished "
      f"{finished:%Y-%m-%d %H:%M} UTC" if finished else f"- Evaluation job: `{job_id}` ({jstatus})")
    w(f"- Dataset: `{jinput['dataset']}` v{jinput['version']}, jurisdiction {jinput['jurisdiction']}, top-k {jinput['k']}")
    sha = {r['git_sha'] for r in runs if r['git_sha']}
    w(f"- Code version: {', '.join(sorted(sha)) or 'not recorded'}")
    w(f"- Report written: {datetime.now(timezone.utc):%Y-%m-%d %H:%M} UTC")
    w("")

    w("## Corpus")
    w("")
    w(f"{len(docs)} documents (current versions). Characters: {sum(d[5] or 0 for d in docs):,}.")
    w("")
    w("| Source | Type | Reliability | Language | Jurisdiction | Characters | Version | Extractor | Retrieved (UTC) |")
    w("|---|---|---|---|---|---|---|---|---|")
    for key, stype, rel, lang, jur, chars, ver, ext, ret in docs:
        w(f"| `{key}` | {stype} | {rel} | {lang} | {jur or 'global'} | {chars:,} | {ver} | {ext} | {ret:%Y-%m-%d %H:%M} |")
    failed = [x for x in last_ingest if x[1] != "ok"]
    if failed:
        w("")
        w("Sources whose last ingestion did not succeed (not in the corpus above unless an earlier version exists):")
        w("")
        for key, status, step, err in failed:
            w(f"- `{key}`: {status} at `{step}`" + (f": {err}" if err else ""))
    w("")
    w("| Strategy | Chunks | Tokens mean | Tokens sd | Min | Max |")
    w("|---|---|---|---|---|---|")
    for strat, n, avg, sd, mn, mx in chunks:
        w(f"| {strat} | {n} | {float(avg):.1f} | {float(sd or 0):.1f} | {mn} | {mx} |")
    w("")
    w("Token counts use the XLM-RoBERTa tokenizer served by TEI for multilingual-e5-large (bge-m3 uses the same vocabulary; D-035).")
    w("")
    w("| Embedding model | Served by | Revision | Query prefix | Passage prefix |")
    w("|---|---|---|---|---|")
    for name, ep, rev, qp, pp in models:
        w(f"| {name} | {ep} | {rev or 'Ollama library tag, see VERSIONS.md'} | `{qp}` | `{pp}` |")
    w("")

    # gold set composition
    any_run = next(iter(results.values()), {})
    groups, tags = {}, {}
    for qid, r in any_run.items():
        g = language_group(r["language"], r["tags"])
        groups[g] = groups.get(g, 0) + 1
        for t in r["tags"]:
            tags[t] = tags.get(t, 0) + 1
    scored = sum(1 for r in any_run.values() if (r["metrics"] or {}).get("gold_spans"))
    w("## Gold set")
    w("")
    w(f"{len(any_run)} queries, {scored} with gold spans (the others are out-of-scope questions kept for the abstention "
      "test of phase 6 and excluded from the retrieval metrics). Gold is a character span in a document, independent "
      "of chunking. A retrieved chunk is relevant when it overlaps a gold span by at least half of the shorter of the "
      "two; each gold span is credited once (D-039).")
    w("")
    w("By language group: " + ", ".join(f"{k} {v}" for k, v in sorted(groups.items())) + ".")
    w("By tag: " + (", ".join(f"`{k}` {v}" for k, v in sorted(tags.items())) or "none") + ".")
    w("")

    w("## All configurations")
    w("")
    w("Reranker: off in every run (not built yet; phase 8). Candidates 50 per leg, RRF constant 60.")
    w("Latency = database search time plus the embedding time per query (all queries embedded in batches, total time "
      "divided by the number of queries); measured on the owner's PC.")
    w("")
    w("| Configuration | " + " | ".join(METRICS) + " | p50 ms | p95 ms |")
    w("|---|" + "---|" * (len(METRICS) + 2))
    for r in sorted(runs, key=lambda r: (r["config"]["strategy"], r["config"]["model"], r["config"]["mode"])):
        s = r["summary"] or {}
        w(f"| {config_label(r['config'])} | " + " | ".join(fmt(s.get(m)) for m in METRICS)
          + f" | {fmt(s.get('latency_ms_p50'), 1)} | {fmt(s.get('latency_ms_p95'), 1)} |")
    w("")

    # primary comparison A vs B, other factors fixed
    w("## Primary comparison: strategy A against strategy B")
    w("")
    w(f"Paired over the scored queries, difference = B minus A, 95% interval from {RESAMPLES} bootstrap resamples "
      f"(seed {SEED}). A difference whose interval contains 0 is not a conclusion.")
    w("")
    by_cfg = {(r["config"]["strategy"], r["config"]["model"], r["config"]["mode"]): r for r in runs}
    w("| Model / mode | Metric | A | B | B - A | 95% interval |")
    w("|---|---|---|---|---|---|")
    for model in sorted({r["config"]["model"] for r in runs}):
        for mode in ("hybrid", "dense", "lexical"):
            ra, rb = by_cfg.get(("fixed_500_50", model, mode)), by_cfg.get(("structure_aware_v1", model, mode))
            if not ra or not rb:
                continue
            qa, qb = results.get(str(ra["id"]), {}), results.get(str(rb["id"]), {})
            ids = [q for q in sorted(qa) if q in qb and (qa[q]["metrics"] or {}).get("gold_spans")]
            for m in PRIMARY_METRICS:
                a = [qa[q]["metrics"].get(m) for q in ids]
                b = [qb[q]["metrics"].get(m) for q in ids]
                d, lo, hi = bootstrap_diff(a, b)
                w(f"| {model} / {mode} | {m} | {fmt(mean(a))} | {fmt(mean(b))} | {fmt(d)} | [{fmt(lo)}, {fmt(hi)}] |")
    w("")

    w("## By language group (hybrid)")
    w("")
    w("| Configuration | Group | Queries | Hit@5 | Recall@5 | MRR |")
    w("|---|---|---|---|---|---|")
    for r in sorted(runs, key=lambda r: (r["config"]["model"], r["config"]["strategy"])):
        if r["config"]["mode"] != "hybrid":
            continue
        per = {}
        for q in results.get(str(r["id"]), {}).values():
            if not (q["metrics"] or {}).get("gold_spans"):
                continue
            per.setdefault(language_group(q["language"], q["tags"]), []).append(q["metrics"])
        for g, ms in sorted(per.items()):
            w(f"| {config_label(r['config'])} | {g} | {len(ms)} | {fmt(mean([m.get('hit@5') for m in ms]))} | "
              f"{fmt(mean([m.get('recall@5') for m in ms]))} | {fmt(mean([m.get('mrr') for m in ms]))} |")
    w("")

    w("## Worst 10 queries")
    w("")
    w("Primary configuration: strategy B, bge-m3, hybrid. Ordered by MRR, then Recall@10. "
      "The explanation column is hand-written after reading the retrieved chunks (marked *notes*); "
      "\"not analysed\" means no note was written yet.")
    w("")
    prim = by_cfg.get(("structure_aware_v1", "bge-m3", "hybrid"))
    if prim:
        qs = [(qid, q) for qid, q in results.get(str(prim["id"]), {}).items() if (q["metrics"] or {}).get("gold_spans")]
        qs.sort(key=lambda x: (x[1]["metrics"].get("mrr") or 0, x[1]["metrics"].get("recall@10") or 0, x[0]))
        w("| Query id | Query | Group | MRR | Recall@10 | Top result | Explanation (*notes*) |")
        w("|---|---|---|---|---|---|---|")
        for qid, q in qs[:10]:
            top = (q["retrieved"] or [{}])[0]
            topdesc = f"`{top.get('source_key')}` {top.get('article_ref') or ''}".strip() if top else "none"
            note = notes.get(qid, "not analysed").replace("|", "\\|")
            w(f"| {qid} | {q['query'].replace('|', '/')} | {language_group(q['language'], q['tags'])} | "
              f"{fmt(q['metrics'].get('mrr'))} | {fmt(q['metrics'].get('recall@10'))} | {topdesc} | {note} |")
    else:
        w("Primary configuration not in this job.")
    w("")
    w("## What was tried and dropped (*notes*)")
    w("")
    w(tried.strip() or "Nothing yet.")
    w("")
    w("## Not measured in this run")
    w("")
    w("- Reranking (cross-encoder): not built; spec 10.5 step 4, planned with the full ablation (phase 8).")
    w("- Source-diverse retrieval for contradictions and query rewriting (spec 10.5 steps 5 and 6): phase 6.")
    w("- Abstention, conflict detection, citation precision and faithfulness: they need the legal answerer (phase 6).")
    w("- Cost: all models run locally; no per-query cost is recorded.")
    w("")
    return "\n".join(L)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dsn", required=True)
    ap.add_argument("--job", required=True)
    ap.add_argument("--out", default=str(ROOT / "docs" / "RETRIEVAL_EVAL.md"))
    a = ap.parse_args()
    import psycopg
    with psycopg.connect(a.dsn) as conn:
        data = load(conn, a.job)
    dataset = data[0][1]["dataset"]
    notes_file = ROOT / "eval" / "datasets" / f"{dataset}_v{data[0][1]['version']}_notes.json"
    notes = json.loads(notes_file.read_text(encoding="utf-8")) if notes_file.exists() else {}
    tried_file = ROOT / "eval" / "reports" / "tried.md"
    tried = tried_file.read_text(encoding="utf-8") if tried_file.exists() else ""
    Path(a.out).write_text(render(*data, notes=notes, tried=tried), encoding="utf-8")
    print("wrote", a.out)


if __name__ == "__main__":
    main()
