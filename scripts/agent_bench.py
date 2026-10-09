#!/usr/bin/env python3
"""A3 Match agent benchmark on the real model (D-084): conversations of eval/datasets/match_agent_v1.jsonl sent to
POST /v1/assistant/message, one new user per conversation, then the first message of every conversation again with
the agent switched off (the fixed path P2 then search) for the same measures.

Per turn: which path answered (agent, fallback to the fixed path, fixed, or another route), the tools the agent
called against the expected tool, the place, budget and move-in month the search used against the expected ones,
whether the answer was kept by the number check, and the latency seen by the client and by the server.

Labels (expected tool, place, budget, month) were written with the dataset (D-084), not by a second annotator.
The search results themselves are not scored: the listings are synthetic (D-060).

    python scripts/agent_bench.py [--dataset eval/datasets/match_agent_v2.jsonl] [--versions 1,2] [--limit N] [--no-baseline]

Each P6_match_agent version in --versions is made the active one for its run (ai.prompt_versions.status), and the
versions' statuses are put back as they were at the end. Per answer also: length, whether it is in the alphabet of
the message, and from the trace step whether the model wrote Markdown or more than match.agent_answer_max_chars.

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


def script_of(text):
    ar = sum(1 for ch in str(text or "") if "\u0600" <= ch <= "\u06ff")
    lat = sum(1 for ch in str(text or "") if ch.isalpha() and ch.isascii() or "\u00c0" <= ch <= "\u024f")
    if ar + lat < 3:
        return None
    return "arabic" if ar > lat else "latin"


def agent_step(conn, request_id):
    row = conn.execute("""select s.output from ai.agent_steps s join ai.executions e on e.id = s.execution_id
                          where e.request_id = %s and s.agent = 'A3_match_agent' order by s.step_index desc limit 1""",
                       (request_id,)).fetchone()
    return row[0] if row else None


def set_statuses(conn, statuses):
    """statuses: {version: status} for P6_match_agent; the active one is set last (one active version at a time)."""
    conn.execute("""update ai.prompt_versions v set status = 'draft' from ai.prompts p
                    where p.id = v.prompt_id and p.name = 'P6_match_agent' and v.status = 'active'""")
    for v, st in sorted(statuses.items(), key=lambda x: x[1] == "active"):
        conn.execute("""update ai.prompt_versions v set status = %s from ai.prompts p
                        where p.id = v.prompt_id and p.name = 'P6_match_agent' and v.version = %s""", (st, v))
    conn.commit()


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
            if row.get("path") == "agent":
                st = agent_step(conn, body.get("request_id")) or {}
                ans = d.get("answer")
                row.update(answer_chars=len(ans) if ans else 0, raw_chars=st.get("raw_chars"),
                           markdown=st.get("markdown_removed"), cut=st.get("cut"),
                           same_script=(script_of(ans) == script_of(turn["text"])) if ans and script_of(turn["text"]) else None)
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
            "answers": {"same_script": rate(agent, "same_script"), "markdown_written": rate(agent, "markdown"),
                        "cut": rate(agent, "cut"), "raw_chars_p50": pct([x.get("raw_chars") for x in agent], 50),
                        "raw_chars_max": pct([x.get("raw_chars") for x in agent], 100),
                        "shown_chars_p50": pct([x.get("answer_chars") for x in agent], 50)},
            "client_ms": {"p50": pct([x["client_ms"] for x in ok], 50), "p95": pct([x["client_ms"] for x in ok], 95),
                          "max": pct([x["client_ms"] for x in ok], 100)},
            "by_kind": by}


def compact(sm):
    """The lines worth reading in the console; the file keeps everything."""
    if not sm:
        return None
    k = sm["by_kind"]
    return {"paths": sm["paths"], "tool_ok": sm["agent_tool_ok"], "answers": sm.get("answers"),
            "client_ms": sm["client_ms"],
            **{f"{n}": {"turns": v["turns"], "tool_ok": v["tool_ok"], "fields_ok": v["fields_ok"]} for n, v in k.items()}}


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--dataset", default=str(ROOT / "eval" / "datasets" / "match_agent_v2.jsonl"))
    ap.add_argument("--versions", default="active", help="P6_match_agent versions to run, e.g. 1,2 (default: the active one)")
    ap.add_argument("--limit", type=int)
    ap.add_argument("--no-baseline", action="store_true")
    a = ap.parse_args()
    items = [json.loads(l) for l in Path(a.dataset).read_text("utf-8").splitlines() if l.strip()][: a.limit]
    c = kb.client()
    c.http.timeout = __import__("httpx").Timeout(300)          # one agent turn makes several model calls
    with psycopg.connect(kb.dsn()) as conn:
        model = conn.execute("select value #>> '{}' from app.settings where key = 'llm.default_model'").fetchone()[0]
        statuses = dict(conn.execute("""select v.version, v.status from ai.prompt_versions v join ai.prompts p on p.id = v.prompt_id
                                        where p.name = 'P6_match_agent'""").fetchall())
        active = [v for v, st in statuses.items() if st == "active"]
        if not active:
            sys.exit("P6_match_agent has no active version: run scripts/prompts.py sync")
        versions = active if a.versions == "active" else [int(x) for x in a.versions.split(",")]
        missing = [v for v in versions if v not in statuses]
        if missing:
            sys.exit(f"P6_match_agent versions not stored: {missing} (scripts/prompts.py sync)")
        n_pub = conn.execute("select count(*) from app.listings where status = 'published' and jurisdiction_code = 'TN'").fetchone()[0]
        conn.execute("update app.settings set value = 'true' where key = 'match.agent_enabled'")
        conn.commit()
        print(f"{len(items)} conversations, {sum(len(i['turns']) for i in items)} turns per version; model {model}; "
              f"P6 versions {versions}; {n_pub} published TN listings", flush=True)
        t_start = time.perf_counter()
        runs = {}
        try:
            for v in versions:
                set_statuses(conn, {**{k: ("draft" if st == "active" else st) for k, st in statuses.items()}, v: "active"})
                rows = []
                for it in items:
                    rs = run_conversation(c, conn, it, f"Agent benchmark (P6 v{v})")
                    rows += rs
                    for r in rs:
                        print(f"v{v} {r['id']} t{r['turn']}: {r.get('path')} tools={r.get('tool_calls')} tool_ok={r.get('tool_ok')} "
                              f"fields_ok={r.get('fields_ok')} chars={r.get('answer_chars')} md={r.get('markdown')} "
                              f"script_ok={r.get('same_script')} {r['client_ms']:.0f} ms", flush=True)
                runs[v] = rows
        finally:
            set_statuses(conn, statuses)
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
    summary = {"date": datetime.now(timezone.utc).isoformat(timespec="seconds"), "model": model, "prompt_versions": versions,
               "dataset": Path(a.dataset).name, "published_tn_listings": n_pub, "minutes": minutes,
               "agent": {f"v{v}": summarize(rows) for v, rows in runs.items()},
               "fixed_path_first_turns": summarize(base) if base else None,
               "load": "sequential, one conversation at a time"}
    stamp = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
    out = ROOT / "reports" / "eval" / f"agent-bench-{stamp}.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps({"summary": summary, "turns": {f"v{v}": rows for v, rows in runs.items()}, "fixed_path": base},
                              ensure_ascii=False, indent=1), encoding="utf-8")
    print(json.dumps({"minutes": minutes, **{f"v{v}": compact(summary["agent"][f"v{v}"]) for v in runs},
                      "fixed_path": compact(summary["fixed_path_first_turns"])}, indent=1, ensure_ascii=False))
    print(f"wrote {out.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
