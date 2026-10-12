#!/usr/bin/env python3
"""Owner assistant benchmark on the real model (D-088): the requests of eval/datasets/owner_agent_v1.jsonl sent to
POST /v1/assistant/message, one new owner per request with one published test listing (TN, rent 350 TND, a TV,
3 photos; synthetic, removed at the end). Nothing is confirmed: the benchmark scores the proposals only.

Per request: the route (owner assistant or another route chosen by the P1 router), the tools called, the proposed
change against the expected one (exact match, and per field), refusals, and the latency seen by the client.
Labels (expected changes) were written with the dataset, not by a second annotator.

    python scripts/owner_bench.py [--dataset eval/datasets/owner_agent_v1.jsonl] [--limit N]

Environment: FS_API_BASE, FS_SECRETS_FILE, FS_TEST_DB_DSN (as scripts/p3.py). Writes reports/eval/owner-bench-*.json.
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


def norm(c):
    c = dict(c or {})
    for k in ("amenities_add", "amenities_remove", "remove_photos"):
        if k in c:
            c[k] = sorted(c[k])
    return c


def new_owner(conn):
    uid = conn.execute("""insert into app.users (external_auth_id, display_name, role, jurisdiction_code)
                          values (%s, 'Owner benchmark', 'owner', 'TN') returning id""",
                       (f"local-owner-bench-{uuid.uuid4().hex[:12]}",)).fetchone()[0]
    for purpose in ("terms", "privacy"):
        conn.execute("insert into app.consents (user_id, purpose, granted, policy_version, source) values (%s, %s, true, 'bench', 'script')",
                     (uid, purpose))
    lid = conn.execute("""insert into app.listings (owner_id, jurisdiction_code, status, title, description, rent_minor, currency,
                                                   location, city, published_at, amenities, source, is_synthetic)
                          values (%s, 'TN', 'published', 'Chambre (benchmark)', 'Chambre de test du benchmark', 350000, 'TND',
                                  st_setsrid(st_makepoint(10.18, 36.86), 4326)::geography, 'Benchmark', now(), '{tv}', 'synthetic', true)
                          returning id""", (uid,)).fetchone()[0]
    for i in range(3):
        conn.execute("""insert into app.listing_media (listing_id, kind, storage_key, mime, bytes, sha256, moderation, created_at)
                        values (%s, 'photo', %s, 'image/jpeg', 1, %s, 'ok', now() - make_interval(secs => %s))""",
                     (lid, f"media/owner-bench/{lid}/{i + 1}.jpg", uuid.uuid4().hex, 10 - i))
    conn.commit()
    return str(uid), str(lid)


def owner_step(conn, request_id):
    row = conn.execute("""select s.output, s.tool_calls from ai.agent_steps s join ai.executions e on e.id = s.execution_id
                          where e.request_id = %s and s.agent = 'A1_owner_agent' order by s.step_index desc limit 1""",
                       (request_id,)).fetchone()
    return (row[0] or {}, row[1] or []) if row else ({}, [])


def score(item, d, tools):
    e = item["expect"]
    p = d.get("proposal") or None
    got = norm(p.get("changes")) if p else None
    errors = [x for t in tools for x in (t.get("errors") or [])]
    out = {"proposed": p is not None, "changes": got, "tool_errors": errors}
    if "refused" in e:
        out["ok"] = p is None and e["refused"] in errors
        out["kind"] = "refusal"
    elif e.get("none") or e.get("none_or_refused"):
        out["ok"] = p is None
        out["kind"] = "no_change"
    else:
        want = norm(e)
        out["kind"] = "change"
        out["ok"] = got == want
        out["fields_right"] = sum(1 for k, v in want.items() if got and got.get(k) == v)
        out["fields_expected"] = len(want)
        out["fields_extra"] = sorted(k for k in (got or {}) if k not in want)
    return out


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--dataset", default=str(ROOT / "eval" / "datasets" / "owner_agent_v1.jsonl"))
    ap.add_argument("--limit", type=int)
    a = ap.parse_args()
    items = [json.loads(l) for l in Path(a.dataset).read_text("utf-8").splitlines() if l.strip()][: a.limit]
    c = kb.client()
    c.http.timeout = __import__("httpx").Timeout(300)
    rows = []
    with psycopg.connect(kb.dsn()) as conn:
        model = conn.execute("select value #>> '{}' from app.settings where key = 'llm.default_model'").fetchone()[0]
        pv = conn.execute("""select v.version from ai.prompt_versions v join ai.prompts p on p.id = v.prompt_id
                             where p.name = 'P11_owner_assistant' and v.status = 'active'""").fetchone()
        if not pv:
            sys.exit("P11_owner_assistant has no active version: run scripts/prompts.py sync")
        conn.execute("update app.settings set value = 'true' where key = 'owner.agent_enabled'")
        conn.commit()
        print(f"{len(items)} requests; model {model}; P11 v{pv[0]}", flush=True)
        t_start = time.perf_counter()
        listings = []
        try:
            for it in items:
                uid, lid = new_owner(conn)
                listings.append(lid)
                t0 = time.perf_counter()
                r = c.call("POST", "/v1/assistant/message", user_id=uid, body={"text": it["text"]})
                ms = round((time.perf_counter() - t0) * 1000, 1)
                body = r.json()
                d = body.get("data") or {}
                owner = r.status_code == 200 and d.get("status") in ("proposed", "answered") and d.get("intent") == "post_listing" \
                    and "proposal" in d
                row = {"id": it["id"], "language": it["language"], "tags": it["tags"], "http": r.status_code, "client_ms": ms,
                       "request_id": body.get("request_id"), "intent": d.get("intent"), "status": d.get("status"),
                       "route": "owner" if owner else ("error" if r.status_code != 200 else "other"), "answer": d.get("answer")}
                if owner:
                    out, tools = owner_step(conn, body.get("request_id"))
                    row.update(tool_calls=[t.get("tool") for t in tools], **score(it, d, tools))
                rows.append(row)
                print(f"{it['id']} {row['route']} {row.get('status')} ok={row.get('ok')} changes={row.get('changes')} "
                      f"tools={row.get('tool_calls')} {ms:.0f} ms", flush=True)
        finally:
            conn.execute("delete from app.listings where id = any(%s::uuid[])", (listings,))
            conn.commit()
        minutes = round((time.perf_counter() - t_start) / 60, 1)

    def rate(xs):
        v = [x["ok"] for x in xs if x.get("ok") is not None]
        return {"n": len(v), "count": sum(v), "rate": round(sum(v) / len(v), 3) if v else None}

    owner_rows = [r for r in rows if r["route"] == "owner"]
    changes = [r for r in owner_rows if r.get("kind") == "change"]
    summary = {
        "date": datetime.now(timezone.utc).isoformat(timespec="seconds"), "model": model, "prompt": f"P11_owner_assistant v{pv[0]}",
        "dataset": Path(a.dataset).name, "requests": len(rows), "minutes": minutes,
        "routes": {k: sum(1 for r in rows if r["route"] == k) for k in ("owner", "other", "error")},
        "other_routes": sorted({f"{r['intent']}/{r['status']}" for r in rows if r["route"] == "other"}),
        "change_exact": rate(changes),
        "fields": {"right": sum(r.get("fields_right", 0) for r in changes), "expected": sum(r.get("fields_expected", 0) for r in changes),
                   "extra": sum(len(r.get("fields_extra") or []) for r in changes)},
        "refusals": rate([r for r in owner_rows if r.get("kind") == "refusal"]),
        "no_change_kept": rate([r for r in owner_rows if r.get("kind") == "no_change"]),
        "listed_first": {"n": len(owner_rows), "count": sum(1 for r in owner_rows if (r.get("tool_calls") or [None])[0] == "my_listings")},
        "client_ms": {"p50": pct([r["client_ms"] for r in owner_rows], 50), "p95": pct([r["client_ms"] for r in owner_rows], 95)},
        "load": "sequential, one request at a time",
    }
    stamp = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
    out = ROOT / "reports" / "eval" / f"owner-bench-{stamp}.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps({"summary": summary, "requests": rows}, ensure_ascii=False, indent=1), encoding="utf-8")
    print(json.dumps(summary, indent=1, ensure_ascii=False))
    print(f"wrote {out.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
