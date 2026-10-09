#!/usr/bin/env python3
"""A3 Match agent benchmark on the real model (D-084): conversations of eval/datasets/match_agent_v1.jsonl sent to
POST /v1/assistant/message, one new user per conversation, then the first message of every conversation again with
the agent switched off (the fixed path P2 then search) for the same measures.

Per turn: which path answered (agent, fallback to the fixed path, fixed, or another route), the tools the agent
called against the expected tool, the place, budget and move-in month the search used against the expected ones,
whether the answer was kept by the number check, and the latency seen by the client and by the server.

Labels (expected tool, place, budget, month) were written with the dataset (D-084), not by a second annotator.
The search results themselves are not scored: the listings are synthetic (D-060).

    python scripts/agent_bench.py [--dataset eval/datasets/match_agent_v1.jsonl] [--limit N] [--no-baseline]

Environment: FS_API_BASE, FS_SECRETS_FILE, FS_TEST_DB_DSN (as scripts/p3.py). Writes reports/eval/agent-bench-*.json.
"""
from __future__ import annotations

import argparse
import json
import math
import sys
import time
import unicodedata
import uuid
from datetime import datetime, timezone
from pathlib import Path

import psycopg

sys.path.insert(0, str(Path(__file__).resolve().parent))
import kb  # noqa: E402

ROOT = Path(__file__).resolve().parents[1]


def norm(s):
    s = unicodedata.normalize("NFD", str(s or "")).lower()
    return "".join(c for c in s if unicodedata.category(c) != "Mn")


def pct(xs, q):
    xs = sorted(v for v in xs if v is not None)
    return xs[max(0, math.ceil(q / 100 * len(xs)) - 1)] if xs else None


def new_user(conn, label):
    uid = conn.execute("""insert into app.users (external_auth_id, display_name, role, jurisdiction_code)
                          values (%s, %s, 'user', 'TN') returning id""",
                       (f"local-agent-bench-{uuid.uuid4().hex[:12]}", label)).fetchone()[0]
    for purpose in ("terms", "privacy"):
        conn.execute("insert into app.consents (user_id, purpose, granted, policy_version, source) values (%s, %s, true, 'bench', 'script')",
                     (uid, purpose))
    conn.commit()
    return str(uid)


def score(turn, d, prev_count):
    e = turn["expect"]
    warnings = d.get("warnings") or []
    if d.get("intent") != "search_listings":
        path = "other_route"
    elif "agent_fallback" in warnings:
        path = "fallback"
    elif "agent" in d:
        path = "agent"
    else:
        path = "fixed"
    calls = (d.get("agent") or {}).get("tool_calls") or []
    out = {"path": path, "tool_calls": calls, "status": d.get("status"), "count": d.get("count"),
           "answer_kept": d.get("answer") is not None if path == "agent" else None,
           "dropped": "agent_answer_unsupported" in warnings}
    if path == "agent":
        out["tool_ok"] = (not calls) if e.get("tool") is None else (e["tool"] in calls)
    else:
        out["tool_ok"] = None
    if e.get("tool") == "listing_details":
        out["applicable"] = (prev_count or 0) >= e.get("number", 1)
    prof = d.get("profile") or {}
    if e.get("tool") == "search_listings" and d.get("status") == "results":
        checks = {}
        if "anchor" in e:
            got = prof.get("anchor_label") or ((d.get("anchor") or {}).get("place") or {}).get("name")
            checks["anchor"] = norm(e["anchor"]) in norm(got)
        if "budget" in e:
            checks["budget"] = prof.get("budget_max_minor") == e["budget"] * 1000
        if "month" in e:
            m = prof.get("move_in_from")
            checks["month"] = bool(m) and int(str(m)[5:7]) == e["month"]
        out["fields"] = checks
        out["fields_ok"] = all(checks.values()) if checks else None
    return out


def run_conversation(c, conn, item, label):
    uid = new_user(conn, label)
    rows, prev_count = [], None
    for i, turn in enumerate(item["turns"]):
        t0 = time.perf_counter()
        r = c.call("POST", "/v1/assistant/message", user_id=uid, body={"text": turn["text"]})
        ms = round((time.perf_counter() - t0) * 1000, 1)
        body = r.json()
        d = body.get("data") or {}
        row = {"id": item["id"], "turn": i + 1, "tags": item["tags"], "http": r.status_code, "client_ms": ms,
               "server_ms": (body.get("meta") or {}).get("latency_ms"), "request_id": body.get("request_id"),
               "error": (body.get("error") or {}).get("code"), "answer": d.get("answer"), "warnings": d.get("warnings")}
        if r.status_code == 200:
            row.update(score(turn, d, prev_count))
            prev_count = d.get("count") if d.get("status") == "results" else prev_count
        rows.append(row)
    return rows


def summarize(rows):
    ok = [r for r in rows if r["http"] == 200]
    agent = [r for r in ok if r.get("path") == "agent"]

    def rate(xs, key):
        v = [x[key] for x in xs if x.get(key) is not None]
        return {"n": len(v), "rate": round(sum(1 for x in v if x) / len(v), 3) if v else None}

    by = {}
    for name, sel in (("first_turn_search", lambda r: r["turn"] == 1),
                      ("followup_search", lambda r: r["turn"] == 2 and "followup" in r["tags"]),
                      ("details", lambda r: r["turn"] == 2 and "details" in r["tags"] and r.get("applicable")),
                      ("no_tool", lambda r: r["turn"] == 2 and "no_tool" in r["tags"])):
        xs = [r for r in ok if sel(r)]
        by[name] = {"turns": len(xs), "paths": {p: sum(1 for x in xs if x.get("path") == p) for p in ("agent", "fallback", "fixed", "other_route")},
                    "tool_ok": rate(xs, "tool_ok"), "fields_ok": rate(xs, "fields_ok"),
                    "client_ms_p50": pct([x["client_ms"] for x in xs], 50), "client_ms_p95": pct([x["client_ms"] for x in xs], 95)}
    return {"turns": len(rows), "http_ok": len(ok), "errors": [r for r in rows if r["http"] != 200][:5],
            "paths": {p: sum(1 for x in ok if x.get("path") == p) for p in ("agent", "fallback", "fixed", "other_route")},
            "agent_tool_ok": rate(agent, "tool_ok"), "agent_answer_kept": rate(agent, "answer_kept"),
            "client_ms": {"p50": pct([x["client_ms"] for x in ok], 50), "p95": pct([x["client_ms"] for x in ok], 95),
                          "max": pct([x["client_ms"] for x in ok], 100)},
            "by_kind": by}


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--dataset", default=str(ROOT / "eval" / "datasets" / "match_agent_v1.jsonl"))
    ap.add_argument("--limit", type=int)
    ap.add_argument("--no-baseline", action="store_true")
    a = ap.parse_args()
    items = [json.loads(l) for l in Path(a.dataset).read_text("utf-8").splitlines() if l.strip()][: a.limit]
    c = kb.client()
    c.http.timeout = __import__("httpx").Timeout(300)          # one agent turn makes several model calls
    with psycopg.connect(kb.dsn()) as conn:
        model = conn.execute("select value #>> '{}' from app.settings where key = 'llm.default_model'").fetchone()[0]
        pv = conn.execute("""select v.version from ai.prompt_versions v join ai.prompts p on p.id = v.prompt_id
                             where p.name = 'P6_match_agent' and v.status = 'active'""").fetchone()
        if not pv:
            sys.exit("P6_match_agent has no active version: run scripts/prompts.py sync")
        n_pub = conn.execute("select count(*) from app.listings where status = 'published' and jurisdiction_code = 'TN'").fetchone()[0]
        conn.execute("update app.settings set value = 'true' where key = 'match.agent_enabled'")
        conn.commit()
        print(f"{len(items)} conversations, {sum(len(i['turns']) for i in items)} turns; model {model}, P6 v{pv[0]}; "
              f"{n_pub} published TN listings", flush=True)
        rows = []
        t_start = time.perf_counter()
        for it in items:
            rs = run_conversation(c, conn, it, "Agent benchmark")
            rows += rs
            for r in rs:
                print(f"{r['id']} t{r['turn']}: {r.get('path')} tools={r.get('tool_calls')} tool_ok={r.get('tool_ok')} "
                      f"fields_ok={r.get('fields_ok')} kept={r.get('answer_kept')} {r['client_ms']:.0f} ms", flush=True)
        base = []
        if not a.no_baseline:
            conn.execute("update app.settings set value = 'false' where key = 'match.agent_enabled'")
            conn.commit()
            try:
                for it in items:
                    first = {**it, "turns": it["turns"][:1]}
                    base += run_conversation(c, conn, first, "Agent benchmark (fixed path)")
                    print(f"{it['id']} fixed path: fields_ok={base[-1].get('fields_ok')} {base[-1]['client_ms']:.0f} ms", flush=True)
            finally:
                conn.execute("update app.settings set value = 'true' where key = 'match.agent_enabled'")
                conn.commit()
        minutes = round((time.perf_counter() - t_start) / 60, 1)
    summary = {"date": datetime.now(timezone.utc).isoformat(timespec="seconds"), "model": model, "prompt_version": pv[0],
               "dataset": Path(a.dataset).name, "published_tn_listings": n_pub, "minutes": minutes,
               "agent": summarize(rows),
               "fixed_path_first_turns": summarize(base) if base else None,
               "load": "sequential, one conversation at a time"}
    stamp = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
    out = ROOT / "reports" / "eval" / f"agent-bench-{stamp}.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps({"summary": summary, "turns": rows, "fixed_path": base}, ensure_ascii=False, indent=1), encoding="utf-8")
    print(json.dumps(summary, indent=1, ensure_ascii=False))
    print(f"wrote {out.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
