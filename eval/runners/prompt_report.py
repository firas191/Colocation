"""docs/PROMPT_EVAL.md from the prompt evaluation runs stored in the database (spec 9.5).

    load(conn) -> data (JSON-serialisable; dumped by scripts/p3.py report)
    render(data) -> markdown

For each prompt and model, the latest succeeded run of each version over the full golden set
is reported (runs on a subset, `limit` or `item_ids`, are listed separately as smoke runs).
Paired comparisons use the bootstrap of eval/runners/report.py (2000 resamples, seed 20261001):
for P1 the per-item intent correctness, for P2 the micro F1 recomputed on each resample.
"""
from __future__ import annotations

import random
from datetime import datetime, timezone

RESAMPLES, SEED = 2000, 20261001


def load(conn) -> dict:
    runs = conn.execute("""
      select r.id::text, r.config, r.summary, r.status, r.started_at, r.finished_at, r.git_sha, r.job_id::text,
             d.name, d.version, d.kind, (select count(*) from eval.queries q where q.dataset_id = d.id) as dataset_items,
             v.version as prompt_version, v.id::text, v.changelog, v.techniques, p.name
      from eval.runs r join eval.datasets d on d.id = r.dataset_id
      left join ai.prompt_versions v on v.id = r.prompt_version_id left join ai.prompts p on p.id = v.prompt_id
      where d.kind in ('routing', 'extraction') and r.status = 'succeeded' and d.name in ('p1_router', 'p2_profile')
      order by r.started_at""").fetchall()
    out = []
    for (rid, cfg, summ, status, t0, t1, sha, job, ds, dsv, kind, n, pv, pvid, changelog, tech, pname) in runs:
        items = conn.execute("""select q.external_id, q.tags, x.metrics, x.output->'output', x.output->>'raw', x.output->'latency_ms'
                                from eval.results x join eval.queries q on q.id = x.query_id where x.run_id = %s
                                order by q.external_id""", (rid,)).fetchall()
        out.append({"run_id": rid, "config": cfg, "summary": summ, "started_at": t0.isoformat(), "finished_at": t1.isoformat() if t1 else None,
                    "git_sha": sha, "job_id": job, "dataset": f"{ds} v{dsv}", "dataset_items": n, "prompt": pname,
                    "version": pv, "version_id": pvid, "changelog": changelog, "techniques": tech,
                    "items": [{"id": e, "tags": t, "metrics": m, "output": o, "raw": (raw or "")[:600], "latency_ms": lat}
                              for e, t, m, o, raw, lat in items]})
    failures = conn.execute("""
      select f.eval_run_id::text, f.category, array_agg(distinct f.item_id order by f.item_id)
      from ai.prompt_failures f where f.eval_run_id = any(%s::uuid[])
      group by 1, 2 order by 1, 2""", ([r["run_id"] for r in out],)).fetchall()
    models = conn.execute("select name, provider, is_local from ai.models where kind = 'llm' order by name").fetchall()
    default = conn.execute("select value #>> '{}' from app.settings where key = 'llm.default_model'").fetchone()
    active = conn.execute("""select p.name, v.version from ai.prompts p join ai.prompt_versions v on v.prompt_id = p.id
                             where v.status = 'active' order by 1""").fetchall()
    return {"generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"), "runs": out,
            "failures": [{"run_id": a, "category": b, "items": c} for a, b, c in failures],
            "models": [list(m) for m in models], "default_model": default[0] if default else None,
            "active": {a: b for a, b in active}}


def fmt(x, d=3):
    return "n/a" if x is None else (f"{x:.{d}f}" if isinstance(x, float) else str(x))


def full_runs(data, prompt):
    """Latest full-set run per (model, version)."""
    best = {}
    for r in data["runs"]:
        if r["prompt"] != prompt or r["config"].get("items") != r["dataset_items"]:
            continue
        best[(r["config"]["model"], r["version"])] = r
    return best


def bootstrap(stat, a_items, b_items):
    """Paired bootstrap of stat(b) - stat(a) over items present in both runs."""
    ia = {x["id"]: x for x in a_items}
    ib = {x["id"]: x for x in b_items}
    keys = sorted(set(ia) & set(ib))
    if not keys:
        return None
    rng = random.Random(SEED)
    n = len(keys)
    base = stat([ib[k] for k in keys]) - stat([ia[k] for k in keys])
    ds = []
    for _ in range(RESAMPLES):
        s = [keys[rng.randrange(n)] for _ in range(n)]
        ds.append(stat([ib[k] for k in s]) - stat([ia[k] for k in s]))
    ds.sort()
    return base, ds[int(0.025 * RESAMPLES)], ds[min(RESAMPLES - 1, int(0.975 * RESAMPLES))]


def p1_acc(items):
    return sum(1 for x in items if x["metrics"].get("intent_ok")) / len(items)


def p2_f1(items):
    tp = sum(x["metrics"].get("tp", 0) for x in items)
    fp = sum(x["metrics"].get("fp", 0) for x in items)
    fn = sum(x["metrics"].get("fn", 0) for x in items)
    p = tp / (tp + fp) if tp + fp else 0.0
    r = tp / (tp + fn) if tp + fn else 0.0
    return 2 * p * r / (p + r) if p + r else 0.0


def render(data) -> str:
    L = ["# Prompt evaluation (P1 router, P2 profile extractor)", "",
         f"Generated by `scripts/p3.py report` from the database on {data['generated_at']}. Do not edit by hand.", "",
         "Golden sets: `eval/datasets/p1_router_v1.jsonl` (160 messages) and `eval/datasets/p2_profile_v1.jsonl` (110 requests), "
         "synthetic, written and labelled by a model-based annotator with a blind 20% re-label (agreement in "
         "`eval/datasets/relabel/`), no human check yet (D-055). Targets from spec 2.6 (starting targets, not measurements): "
         "router intent accuracy at least 0.95, profile field F1 at least 0.90.", "",
         f"Default model (setting `llm.default_model`): `{data['default_model']}`. Active versions: "
         + ", ".join(f"{k} v{v}" for k, v in sorted(data["active"].items())) + ".", ""]
    if not data["runs"]:
        L.append("No prompt evaluation run in the database yet.")
        return "\n".join(L) + "\n"
    # ---------------- P1
    p1 = full_runs(data, "P1_router")
    if p1:
        L += ["## P1 router", "",
              "| Model | Version | JSON valid | First try valid | Intent acc. | Acceptable intent | Intent macro F1 | Language | Arabic family | Script | Hint | Clarification P / R | Injection pass | Leaks | p50 / p95 ms | Tokens in / out |",
              "|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|"]
        for (m, v), r in sorted(p1.items()):
            s = r["summary"]
            L.append(f"| {m} | v{v} | {fmt(s['json_valid'])} | {fmt(s['first_attempt_valid'])} | {fmt(s['intent_accuracy'])} | "
                     f"{fmt(s['intent_acceptable_accuracy'])} | {fmt(s['intent_macro_f1'])} | {fmt(s['language_accuracy'])} | "
                     f"{fmt(s['language_family_accuracy'])} | {fmt(s['script_accuracy'])} | {fmt(s['jurisdiction_hint_accuracy'])} | "
                     f"{fmt(s['clarification_precision'])} / {fmt(s['clarification_recall'])} | {fmt(s['injection_pass'])} "
                     f"({s['injection_items']}) | {s['prompt_leaks']} | {s['latency_p50_ms']} / {s['latency_p95_ms']} | "
                     f"{s['tokens_in_avg']} / {s['tokens_out_avg']} |")
        L += ["", "Intent accuracy by language group:", "", "| Model | Version | " + " | ".join(sorted({g for r in p1.values() for g in r['summary']['by_group']})) + " |",
              "|---|---|" + "---|" * len({g for r in p1.values() for g in r['summary']['by_group']})]
        groups = sorted({g for r in p1.values() for g in r["summary"]["by_group"]})
        for (m, v), r in sorted(p1.items()):
            bg = r["summary"]["by_group"]
            L.append(f"| {m} | v{v} | " + " | ".join(f"{fmt(bg[g]['intent_accuracy'])} ({bg[g]['items']})" if g in bg else "" for g in groups) + " |")
        L += ["", "Paired differences (later version minus earlier, same model), 95% bootstrap interval:", ""]
        for m in sorted({m for m, _ in p1}):
            vs = sorted(v for mm, v in p1 if mm == m)
            for a, b in zip(vs, vs[1:]):
                d = bootstrap(p1_acc, p1[(m, a)]["items"], p1[(m, b)]["items"])
                if d:
                    L.append(f"- {m}, intent accuracy v{b} - v{a}: {d[0]:+.3f} [{d[1]:+.3f}, {d[2]:+.3f}]")
        L.append("")
    # ---------------- P2
    p2 = full_runs(data, "P2_profile_extractor")
    if p2:
        L += ["## P2 profile extractor", "",
              "| Model | Version | JSON valid | First try valid | Precision | Recall | F1 | Exact items | Unit errors (items) | Invented budget (of no-budget items) | Protected terms in unparsed | Protected mapped | p50 / p95 ms | Tokens in / out |",
              "|---|---|---|---|---|---|---|---|---|---|---|---|---|---|"]
        for (m, v), r in sorted(p2.items()):
            s = r["summary"]
            L.append(f"| {m} | v{v} | {fmt(s['json_valid'])} | {fmt(s['first_attempt_valid'])} | {fmt(s['precision'])} | {fmt(s['recall'])} | "
                     f"{fmt(s['f1'])} | {fmt(s['exact_items'])} | {s['unit_error_items']} | {s['invented_budget_items']} of {s['no_budget_items']} | "
                     f"{fmt(s['protected_in_unparsed'])} ({s['protected_terms']}) | {s['protected_mapped_items']} | "
                     f"{s['latency_p50_ms']} / {s['latency_p95_ms']} | {s['tokens_in_avg']} / {s['tokens_out_avg']} |")
        fields = sorted({f for r in p2.values() for f in r["summary"]["per_field"]})
        L += ["", "F1 per field:", "", "| Model | Version | " + " | ".join(fields) + " |", "|---|---|" + "---|" * len(fields)]
        for (m, v), r in sorted(p2.items()):
            pf = r["summary"]["per_field"]
            L.append(f"| {m} | v{v} | " + " | ".join(fmt(pf[f]["f1"]) if f in pf else "" for f in fields) + " |")
        tags = ["unit_trap", "no_budget", "relative_date", "protected_pref", "commute", "foreign_currency", "weekly", "injection",
                "aeb_latin", "aeb_arabic", "ar", "mixed", "fr", "en"]
        L += ["", "F1 by tag:", "", "| Model | Version | " + " | ".join(tags) + " |", "|---|---|" + "---|" * len(tags)]
        for (m, v), r in sorted(p2.items()):
            bt = r["summary"]["by_tag"]
            L.append(f"| {m} | v{v} | " + " | ".join(f"{fmt(bt[t]['f1'])} ({bt[t]['items']})" if t in bt else "" for t in tags) + " |")
        L += ["", "Paired differences (later version minus earlier, same model), 95% bootstrap interval:", ""]
        for m in sorted({m for m, _ in p2}):
            vs = sorted(v for mm, v in p2 if mm == m)
            for a, b in zip(vs, vs[1:]):
                d = bootstrap(p2_f1, p2[(m, a)]["items"], p2[(m, b)]["items"])
                if d:
                    L.append(f"- {m}, field F1 v{b} - v{a}: {d[0]:+.3f} [{d[1]:+.3f}, {d[2]:+.3f}]")
        L.append("")
    # ---------------- failures (only the runs used in the tables above; earlier runs of the same
    # model and version are superseded and listed under Runs)
    used = {r["run_id"]: r for pr in ("P1_router", "P2_profile_extractor") for r in full_runs(data, pr).values()}
    fl = [f for f in data["failures"] if f["run_id"] in used]
    if fl:
        L += ["## Failures recorded (ai.prompt_failures, runs used above)", "",
              "Items: number of distinct golden items with at least one failure of that category.", "",
              "| Prompt | Model | Version | Category | Items | Examples |", "|---|---|---|---|---|---|"]
        fl.sort(key=lambda f: (used[f["run_id"]]["prompt"], used[f["run_id"]]["config"]["model"], used[f["run_id"]]["version"], -len(f["items"])))
        for f in fl:
            r = used[f["run_id"]]
            L.append(f"| {r['prompt']} | {r['config']['model']} | v{r['version']} | {f['category']} | {len(f['items'])} | {', '.join(f['items'][:6])} |")
        L.append("")
    smoke = [r for r in data["runs"] if r["config"].get("items") != r["dataset_items"]]
    if smoke:
        L += ["## Smoke runs (subsets, not comparable)", ""]
        for r in smoke:
            L.append(f"- {r['prompt']} v{r['version']} on {r['config']['model']}: {r['config']['items']} items, run {r['run_id'][:8]}")
        L.append("")
    L += ["## Runs", "", "Used: the run shown in the tables above (latest full run of that model and version); superseded runs are kept for the record.", "",
          "| Run | Prompt | Version | Model | Items | Started | Finished | Git | Used |", "|---|---|---|---|---|---|---|---|---|"]
    for r in data["runs"]:
        L.append(f"| {r['run_id'][:8]} | {r['prompt']} | v{r['version']} | {r['config']['model']} | {r['config']['items']} | "
                 f"{r['started_at'][:19]} | {(r['finished_at'] or '')[:19]} | {r['git_sha'] or ''} | {'yes' if r['run_id'] in used else 'superseded'} |")
    return "\n".join(L) + "\n"
