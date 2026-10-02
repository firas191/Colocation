"""eval/runners/report.py: language groups, paired bootstrap, and a render smoke test."""
import sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "eval" / "runners"))
import report  # noqa: E402


def test_language_groups():
    assert report.language_group("fr", []) == "French"
    assert report.language_group("ar", []) == "Arabic script"
    assert report.language_group("ar-TN", ["arabizi"]) == "transliterated"
    assert report.language_group("fr", ["code_switch"]) == "mixed"
    assert report.language_group("en", ["cross_lingual"]) == "English"


def test_bootstrap_is_paired_and_reproducible():
    a = [0.0, 0.5, 1.0, 0.0, 1.0, 0.25]
    b = [0.5, 0.5, 1.0, 1.0, 1.0, 0.25]
    d1 = report.bootstrap_diff(a, b)
    d2 = report.bootstrap_diff(a, b)
    assert d1 == d2                                   # fixed seed
    point, lo, hi = d1
    assert abs(point - 0.25) < 1e-12
    assert lo <= point <= hi
    assert lo >= 0.0                                  # no pair has b < a
    same = report.bootstrap_diff(a, a)
    assert same == (0.0, 0.0, 0.0)
    assert report.bootstrap_diff([None], [1.0]) == (None, None, None)


def test_render_smoke():
    now = datetime(2026, 10, 1, tzinfo=timezone.utc)
    job = ("j1", {"dataset": "d", "version": 1, "jurisdiction": "ZZ", "k": 10}, {}, "succeeded", now, now)
    cfgs = [{"strategy": s, "model": "bge-m3", "mode": "hybrid"} for s in ("fixed_500_50", "structure_aware_v1")]
    runs = [{"id": f"r{i}", "config": c, "summary": {"mrr": 0.5, "hit@5": 1.0, "latency_ms_p50": 10, "latency_ms_p95": 20},
             "git_sha": "abc", "started_at": now, "finished_at": now, "status": "succeeded"} for i, c in enumerate(cfgs)]
    m = {"gold_spans": 1, "mrr": 0.5, "hit@5": 1, "recall@5": 1.0, "recall@10": 1.0, "ndcg@10": 0.6}
    results = {r["id"]: {"q1": {"language": "fr", "tags": [], "query": "dépôt | garantie", "metrics": m,
                                "retrieved": [{"source_key": "s1", "article_ref": "X art. 1"}]}} for r in runs}
    docs = [("s1", "primary_law", 5, "fr", "ZZ", 1000, 1, "html_v1", now)]
    chunks = [("fixed_500_50", 3, 480.0, 20.0, 400, 500)]
    models = [("bge-m3", "ollama", None, "", "")]
    text = report.render(job, runs, results, docs, chunks, models, [("s2", "failed", "fetch", "fetch_http_404")],
                         notes={"q1": "split | article"}, tried="- nothing")
    assert "# Retrieval evaluation" in text
    assert "| A fixed_500_50 / bge-m3 / hybrid |" in text
    assert "`s2`: failed at `fetch`: fetch_http_404" in text
    assert "split \\| article" in text and "dépôt / garantie" in text
    assert "[0.000, 0.000]" in text                    # identical A and B: interval at 0


def test_dump_round_trip_renders_the_same_report():
    import json
    from decimal import Decimal
    now = datetime(2026, 10, 2, 14, 47, tzinfo=timezone.utc)
    job = ("j1", {"dataset": "d", "version": 1, "jurisdiction": "TN", "k": 10}, {}, "succeeded", now, now)
    cfgs = [{"strategy": s, "model": "bge-m3", "mode": "hybrid"} for s in ("fixed_500_50", "structure_aware_v1")]
    runs = [{"id": f"r{i}", "config": c, "summary": {"mrr": 0.25}, "git_sha": "abc", "started_at": now,
             "finished_at": now, "status": "succeeded"} for i, c in enumerate(cfgs)]
    m = {"gold_spans": 1, "mrr": 0.25, "recall@10": 0.5}
    results = {r["id"]: {"q1": {"language": "fr", "tags": [], "query": "q", "metrics": m, "retrieved": []}} for r in runs}
    docs = [("s1", "primary_law", 5, "fr", "TN", 1000, 1, "html_v1", now)]
    chunks = [("fixed_500_50", 3, Decimal("480.5"), Decimal("20.25"), 400, 500)]
    models = [("bge-m3", "ollama", None, "", "")]
    last = [("s1", "skipped", "unchanged", None), ("s2", "skipped", "robots", None)]
    data = (job, runs, results, docs, chunks, models, last)
    back = report.from_json(json.loads(json.dumps(report.to_json(data, {"q1": []}))))
    a = report.render(*data, notes={}, tried="")
    b = report.render(*back, notes={}, tried="")
    strip = lambda t: "\n".join(l for l in t.splitlines() if not l.startswith("- Report written"))  # noqa: E731
    assert strip(a) == strip(b)
    assert "`s2`: skipped at `robots`" in a and "`s1`" not in a.split("## Gold set")[0].split("did not store")[1]
