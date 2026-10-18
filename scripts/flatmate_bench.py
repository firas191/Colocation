#!/usr/bin/env python3
"""Flatmate profile agent benchmark on the real model (platform P12, D-115): each first message of
eval/datasets/flatmate_onboarding_v1.jsonl is sent to POST /v1/me/flatmate-profile/assistant for a new TN user
(synthetic, removed at the end). Nothing is saved: the benchmark scores the proposal the person would be shown.

Per message:
  - each expected field found with the expected value (lifestyle answers one by one, areas as a set, ignoring case);
  - extra fields the proposal has that the message does not state (shown to the person to check; counted, not failed);
  - forbidden fields (a budget or an area the message does not give): must never reach the proposal. The code drops
    them (supportedByText); how often it had to is counted from the answer's "dropped" list;
  - at most two questions in the answer (Yosr's rule for her onboarding agent);
  - the tools called and the latency seen by the client.
Labels were written with the set, before any run; no second annotator.

    python scripts/flatmate_bench.py [--dataset eval/datasets/flatmate_onboarding_v1.jsonl] [--limit N]

Environment: FS_API_BASE, FS_SECRETS_FILE, FS_TEST_DB_DSN (as scripts/p3.py). Writes reports/eval/flatmate-bench-*.json.
"""
from __future__ import annotations

import argparse
import json
import math
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


def new_user(conn):
    uid = conn.execute("""insert into app.users (external_auth_id, display_name, role, jurisdiction_code)
                          values (%s, 'Bench', 'user', 'TN') returning id""", (f"local-fm-bench-{uuid.uuid4().hex[:12]}",)).fetchone()[0]
    for purpose in ("terms", "privacy"):
        conn.execute("insert into app.consents (user_id, purpose, granted, policy_version, source) values (%s, %s, true, 'bench', 'script')",
                     (uid, purpose))
    conn.commit()
    return str(uid)


def flat(p):
    """proposal or expected -> {field: value}; lifestyle answers become lifestyle.<key>, areas a lower-case set."""
    out = {}
    for k, v in (p or {}).items():
        if k == "lifestyle":
            out.update({f"lifestyle.{a}": b for a, b in (v or {}).items()})
        elif k in ("areas", "languages"):
            out[k] = frozenset(str(x).strip().lower() for x in v)
        else:
            out[k] = v
    return out


def same(a, b):
    if isinstance(a, (int, float)) and isinstance(b, (int, float)):
        return abs(a - b) < 0.005
    return a == b


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--dataset", default=str(ROOT / "eval" / "datasets" / "flatmate_onboarding_v1.jsonl"))
    ap.add_argument("--limit", type=int)
    a = ap.parse_args()
    items = [json.loads(l) for l in Path(a.dataset).read_text("utf-8").splitlines() if l.strip()][: a.limit]
    c = kb.client()
    c.http.timeout = __import__("httpx").Timeout(600)
    rows, made = [], []
    with psycopg.connect(kb.dsn()) as conn:
        model = conn.execute("select value #>> '{}' from app.settings where key = 'llm.default_model'").fetchone()[0]
        pv = conn.execute("""select v.version from ai.prompt_versions v join ai.prompts p on p.id = v.prompt_id
                             where p.name = 'P13_flatmate_onboarding' and v.status = 'active'""").fetchone()
        if not pv:
            sys.exit("P13_flatmate_onboarding has no active version: run scripts/prompts.py sync")
        on = conn.execute("select value #>> '{}' from app.settings where key = 'flatmate_agent.enabled'").fetchone()
        if on and on[0] != "true":
            sys.exit("flatmate_agent.enabled is off: nothing to measure")
        print(f"{len(items)} messages; model {model}; P13 v{pv[0]}", flush=True)
        t_start = time.perf_counter()
        try:
            for it in items:
                uid = new_user(conn)
                made.append(uid)
                t0 = time.perf_counter()
                r = c.call("POST", "/v1/me/flatmate-profile/assistant", user_id=uid, body={"text": it["text"]},
                           idem="bench-" + uuid.uuid4().hex)
                ms = round((time.perf_counter() - t0) * 1000, 1)
                d = (r.json().get("data") or {}) if r.headers.get("content-type", "").startswith("application/json") else {}
                got, exp = flat(d.get("proposal")), flat(it["expected"])
                step = conn.execute("""select s.tool_calls from ai.agent_steps s join ai.executions e on e.id = s.execution_id
                                       where e.request_id = %s and s.agent = 'A7_flatmate_agent' order by s.id desc limit 1""",
                                    (r.headers.get("X-Request-Id"),)).fetchone()
                answer = d.get("answer") or ""
                row = {"id": it["id"], "language": it["language"], "tags": it["tags"], "http": r.status_code, "client_ms": ms,
                       "answer": answer, "proposal": d.get("proposal"), "dropped": d.get("dropped") or [],
                       "fields_expected": len(exp), "fields_found": sum(1 for k, v in exp.items() if k in got and same(got[k], v)),
                       "missed": sorted(k for k, v in exp.items() if not (k in got and same(got[k], v))),
                       "extra": sorted(k for k in got if k not in exp),
                       "forbidden_shown": sorted(k for k in it["forbidden"] if k in got),
                       "questions": answer.count("?") + answer.count("؟"),
                       "tool_calls": [t.get("tool") for t in (step[0] or [])] if step else []}
                row["exact"] = not row["missed"] and not row["forbidden_shown"]
                rows.append(row)
                print(f"{it['id']} {row['http']} found={row['fields_found']}/{row['fields_expected']} missed={row['missed']} "
                      f"extra={row['extra']} dropped={len(row['dropped'])} forbidden={row['forbidden_shown']} q={row['questions']} "
                      f"tools={row['tool_calls']} {ms:.0f} ms", flush=True)
        finally:
            conn.rollback()
            conn.execute("delete from agent_memory.chat_histories where session_id = any(%s)", ([f"flatmate:{u}" for u in made],))
            conn.execute("delete from app.users where id = any(%s::uuid[])", (made,))
            conn.commit()
        minutes = round((time.perf_counter() - t_start) / 60, 1)

    fe = sum(r["fields_expected"] for r in rows)
    summary = {"run_at": datetime.now(timezone.utc).isoformat(timespec="seconds"), "dataset": Path(a.dataset).name, "model": model,
               "prompt_version": pv[0], "messages": len(rows), "minutes": minutes, "http_200": sum(1 for r in rows if r["http"] == 200),
               "field_recall": round(sum(r["fields_found"] for r in rows) / fe, 3) if fe else None,
               "exact_messages": sum(1 for r in rows if r["exact"]),
               "with_extra_fields": sum(1 for r in rows if r["extra"]),
               "forbidden_shown": sum(len(r["forbidden_shown"]) for r in rows),
               "dropped_by_code": sum(len(r["dropped"]) for r in rows),
               "more_than_two_questions": sum(1 for r in rows if r["questions"] > 2),
               "propose_profile_called": sum(1 for r in rows if "propose_profile" in r["tool_calls"]),
               "client_ms": {"p50": pct([r["client_ms"] for r in rows], 50), "p95": pct([r["client_ms"] for r in rows], 95)}}
    out = ROOT / "reports" / "eval" / f"flatmate-bench-{datetime.now().strftime('%Y%m%d-%H%M%S')}.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps({"summary": summary, "rows": rows}, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(summary, ensure_ascii=False, indent=2))
    print(f"wrote {out}")


if __name__ == "__main__":
    main()
