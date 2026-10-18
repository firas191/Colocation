#!/usr/bin/env python3
"""Document agent benchmark on the real model (platform P9, D-108): each request of eval/datasets/document_agent_v1.jsonl
is sent to POST /v1/households/{id}/documents/assistant for a new TN household (two flatmates with names, an address,
one house rule; synthetic, removed at the end). Nothing is rendered: the benchmark scores the stored proposal.

Per request: the kind proposed against the expected one (or no proposal when none is expected), each expected value
found in the proposal, the slots still missing against the expected ones, any value outside the template's slots (the
code drops them; counted from the trace), the tools called and the latency seen by the client. Labels were written
with the set, before any run; no second annotator.

    python scripts/document_bench.py [--dataset eval/datasets/document_agent_v1.jsonl] [--limit N]

Environment: FS_API_BASE, FS_SECRETS_FILE, FS_TEST_DB_DSN (as scripts/p3.py). Writes reports/eval/document-bench-*.json.
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


def new_household(conn, c):
    """Two named flatmates and their household, made through the API as the website does (the database role of the
    scripts has no rights on the household tables)."""
    users = []
    for name in ("Amel", "Bilel"):
        uid = conn.execute("""insert into app.users (external_auth_id, display_name, role, jurisdiction_code)
                              values (%s, %s, 'user', 'TN') returning id""", (f"local-doc-bench-{uuid.uuid4().hex[:12]}", name)).fetchone()[0]
        for purpose in ("terms", "privacy"):
            conn.execute("insert into app.consents (user_id, purpose, granted, policy_version, source) values (%s, %s, true, 'bench', 'script')",
                         (uid, purpose))
        users.append(str(uid))
    conn.commit()
    k = lambda: "bench-" + uuid.uuid4().hex
    h = c.call("POST", "/v1/households", user_id=users[0], idem=k(),
               body={"name": "Benchmark", "jurisdiction_code": "TN", "address_text": "12 rue des Oliviers, Ariana"}).json()["data"]["household_id"]
    code = c.call("POST", f"/v1/households/{h}/invites", user_id=users[0], idem=k(), body={"role": "flatmate"}).json()["data"]["code"]
    c.call("POST", "/v1/household-invites/accept", user_id=users[1], idem=k(), body={"code": code})
    c.call("PUT", f"/v1/households/{h}/rules", user_id=users[0], idem=k(), body={"items": [{"category": "quiet", "text": "Calme après 22 h"}]})
    return h, users


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--dataset", default=str(ROOT / "eval" / "datasets" / "document_agent_v1.jsonl"))
    ap.add_argument("--limit", type=int)
    a = ap.parse_args()
    items = [json.loads(l) for l in Path(a.dataset).read_text("utf-8").splitlines() if l.strip()][: a.limit]
    c = kb.client()
    c.http.timeout = __import__("httpx").Timeout(600)
    rows, made = [], []
    with psycopg.connect(kb.dsn()) as conn:
        model = conn.execute("select value #>> '{}' from app.settings where key = 'llm.default_model'").fetchone()[0]
        pv = conn.execute("""select v.version from ai.prompt_versions v join ai.prompts p on p.id = v.prompt_id
                             where p.name = 'P9_document_agent' and v.status = 'active'""").fetchone()
        if not pv:
            sys.exit("P9_document_agent has no active version: run scripts/prompts.py sync")
        print(f"{len(items)} requests; model {model}; P9 v{pv[0]}", flush=True)
        t_start = time.perf_counter()
        try:
            for it in items:
                hid, users = new_household(conn, c)
                made.append((hid, users))
                t0 = time.perf_counter()
                r = c.call("POST", f"/v1/households/{hid}/documents/assistant", user_id=users[0], body={"text": it["text"]},
                           idem="bench-" + uuid.uuid4().hex)
                ms = round((time.perf_counter() - t0) * 1000, 1)
                body = r.json()
                d = body.get("data") or {}
                dr = d.get("draft") or None
                step = conn.execute("""select s.tool_calls from ai.agent_steps s join ai.executions e on e.id = s.execution_id
                                       where e.request_id = %s and s.agent = 'A6_document_agent' order by s.id desc limit 1""",
                                    (r.headers.get("X-Request-Id"),)).fetchone()
                exp_kind = it["expected_kind"]
                vals = (dr or {}).get("values") or {}
                row = {"id": it["id"], "language": it["language"], "tags": it["tags"], "http": r.status_code, "client_ms": ms,
                       "answer": d.get("answer"), "kind": (dr or {}).get("kind"), "missing": (dr or {}).get("missing"),
                       "kind_ok": ((dr or {}).get("kind") == exp_kind) if exp_kind else dr is None,
                       "values_ok": all(vals.get(k) == v for k, v in it["expected_values"].items()) if exp_kind else None,
                       "missing_ok": (sorted((dr or {}).get("missing") or []) == sorted(it["expected_missing"])) if exp_kind and dr else None,
                       "tool_calls": [t.get("tool") for t in (step[0] or [])] if step else []}
                rows.append(row)
                print(f"{it['id']} {row['http']} kind={row['kind']} ok={row['kind_ok']} values={row['values_ok']} missing={row['missing']} "
                      f"tools={row['tool_calls']} {ms:.0f} ms", flush=True)
        finally:
            conn.rollback()
            for hid, users in made:                  # memberships, drafts and documents' authors go with the users;
                conn.execute("delete from app.users where id = any(%s::uuid[])", (users,))  # the empty households stay
            conn.commit()
        minutes = round((time.perf_counter() - t_start) / 60, 1)

    def rate(xs):
        xs = [x for x in xs if x is not None]
        return round(sum(1 for x in xs if x) / len(xs), 3) if xs else None
    summary = {"run_at": datetime.now(timezone.utc).isoformat(timespec="seconds"), "dataset": Path(a.dataset).name, "model": model,
               "prompt_version": pv[0], "requests": len(rows), "minutes": minutes, "http_200": sum(1 for r in rows if r["http"] == 200),
               "kind_accuracy": rate([r["kind_ok"] for r in rows]), "values_accuracy": rate([r["values_ok"] for r in rows]),
               "missing_accuracy": rate([r["missing_ok"] for r in rows]),
               "client_ms": {"p50": pct([r["client_ms"] for r in rows], 50), "p95": pct([r["client_ms"] for r in rows], 95)}}
    out = ROOT / "reports" / "eval" / f"document-bench-{datetime.now().strftime('%Y%m%d-%H%M%S')}.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps({"summary": summary, "rows": rows}, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(summary, ensure_ascii=False, indent=2))
    print(f"wrote {out}")


if __name__ == "__main__":
    main()
