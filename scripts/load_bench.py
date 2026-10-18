#!/usr/bin/env python3
"""Load test of search and messages (platform P12, D-111), meant for the PC: numbers from any other machine are not
the PC's and are not reported as such.

Each level runs N workers for the given seconds. Every worker is its own test user, signs its requests like the
website does (FS1-HMAC, through the proxy) and loops:
  search    GET /v2/search, the website's search page query (TN, a random budget, kind and city word)
  messages  POST /v1/conversations/{id}/messages then GET the thread, in the worker's own conversation with a
            benchmark owner (the trust scan of P8 runs on every message, as in real use)
The gateway and message rate limits are raised for the run and put back afterwards (they would otherwise measure
the limiter, not the stack); everything the run creates is deleted at the end.

    python scripts/load_bench.py [--levels 1,5,10,20] [--seconds 30] [--only search|messages]

Environment: FS_API_BASE, FS_SECRETS_FILE, FS_TEST_DB_DSN (as the contract tests). Writes reports/load/load-*.json
with, per level and endpoint: requests, requests per second, errors by status, latency p50/p95/p99 and max in ms.
"""
from __future__ import annotations

import argparse
import json
import os
import random
import sys
import threading
import time
import uuid
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path

import psycopg
from psycopg.types.json import Jsonb

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tests" / "client"))
from fsclient import Client  # noqa: E402

LIMITS = {"gateway.rate_limit_user_per_min": 1000000, "gateway.rate_limit_ip_per_min": 1000000, "messages.per_minute": 1000000}
WORDS = ["", "Tunis", "Ariana", "La Marsa", "Sousse", "meublée", "chambre", "studio"]


def secrets():
    vals = {}
    for line in Path(os.environ.get("FS_SECRETS_FILE", "secrets/api-clients.env")).read_text().splitlines():
        if "=" in line and not line.startswith("#"):
            k, v = line.split("=", 1)
            vals[k.strip()] = v.strip()
    return vals


def pct(xs, q):
    xs = sorted(xs)
    return round(xs[min(len(xs) - 1, int(round(q * (len(xs) - 1))))], 1) if xs else None


def make_user(db, tag, i):
    uid = str(db.execute("""insert into app.users (external_auth_id, role, jurisdiction_code, display_name, email)
                            values (%s, 'user', 'TN', %s, %s) returning id""",
                         (f"loadbench-{tag}-{i}", f"Load {i}", f"loadbench-{tag}-{i}@example.test")).fetchone()[0])
    for p in ("terms", "privacy"):
        db.execute("insert into app.consents (user_id, purpose, granted, policy_version) values (%s, %s, true, 'loadbench')", (uid, p))
    return uid


def run_level(base, sec, workers, seconds, kind, convs):
    stats = {"search": [], "messages_send": [], "messages_read": []}
    errors = {k: Counter() for k in stats}
    lock = threading.Lock()
    stop = time.monotonic() + seconds

    def rec(name, t0, r):
        ms = (time.perf_counter() - t0) * 1000
        with lock:
            if 200 <= r.status_code < 300:
                stats[name].append(ms)
            else:
                errors[name][str(r.status_code)] += 1

    def worker(i):
        c = Client(base, sec["FLATSHARE_TESTS_KEY_ID"], sec["FLATSHARE_TESTS_SECRET"], timeout=60)
        uid, conv = convs[i]
        rnd = random.Random(i)
        while time.monotonic() < stop:
            try:
                if kind == "search":
                    p = {"jurisdiction": "TN", "max_rent": str(rnd.choice([300, 450, 600, 900])), "currency": "TND", "period": "month"}
                    w = rnd.choice(WORDS)
                    if w:
                        p["q"] = w
                    if rnd.random() < 0.5:
                        p["kind"] = rnd.choice(["room", "shared_flat"])
                    t0 = time.perf_counter()
                    rec("search", t0, c.call("GET", "/v2/search", user_id=uid, params=p))
                else:
                    t0 = time.perf_counter()
                    rec("messages_send", t0, c.call("POST", f"/v1/conversations/{conv}/messages", user_id=uid,
                                                    body={"text": f"Bonjour, la chambre est-elle libre ? ({rnd.randint(1, 10**6)})"},
                                                    idem="lb-" + uuid.uuid4().hex))
                    t0 = time.perf_counter()
                    rec("messages_read", t0, c.call("GET", f"/v1/conversations/{conv}/messages", user_id=uid))
            except Exception as e:  # a timeout or a dropped connection is an error of the run, not of the script
                with lock:
                    errors["search" if kind == "search" else "messages_send"][type(e).__name__] += 1

    threads = [threading.Thread(target=worker, args=(i,)) for i in range(workers)]
    t_start = time.monotonic()
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    took = time.monotonic() - t_start
    out = {}
    for name, xs in stats.items():
        n = len(xs) + sum(errors[name].values())
        if n == 0:
            continue
        out[name] = {"requests": n, "ok": len(xs), "per_s": round(len(xs) / took, 1), "errors": dict(errors[name]),
                     "p50_ms": pct(xs, 0.5), "p95_ms": pct(xs, 0.95), "p99_ms": pct(xs, 0.99), "max_ms": round(max(xs), 1) if xs else None}
    return round(took, 1), out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--levels", default="1,5,10,20")
    ap.add_argument("--seconds", type=int, default=30)
    ap.add_argument("--only", choices=["search", "messages"])
    a = ap.parse_args()
    levels = [int(x) for x in a.levels.split(",")]
    base = os.environ.get("FS_API_BASE", "http://localhost:8080").rstrip("/")
    sec = secrets()
    db = psycopg.connect(os.environ["FS_TEST_DB_DSN"], autocommit=True)
    tag = uuid.uuid4().hex[:8]
    keep = {k: db.execute("select value from app.settings where key = %s", (k,)).fetchone()[0] for k in LIMITS}
    owner = make_user(db, tag, "owner")
    lid = str(uuid.uuid4())
    db.execute("""insert into app.listings (id, owner_id, jurisdiction_code, status, title, description, published_at, is_synthetic, source)
                  values (%s, %s, 'TN', 'draft', 'Load bench', 'x', null, true, 'synthetic')""", (lid, owner))
    users = []
    report = {"started_at": datetime.now(timezone.utc).isoformat(timespec="seconds"), "base": base, "seconds": a.seconds,
              "machine": os.environ.get("COMPUTERNAME") or os.uname().nodename,
              "published_listings_tn": db.execute("select count(*) from app.listings where status = 'published' and jurisdiction_code = 'TN'").fetchone()[0],
              "levels": []}
    try:
        for k, v in LIMITS.items():
            db.execute("update app.settings set value = %s where key = %s", (Jsonb(v), k))
        # the listing is published only for the run, so a conversation can be opened about it
        db.execute("update app.listings set status = 'published', published_at = now() where id = %s", (lid,))
        boot = Client(base, sec["FLATSHARE_TESTS_KEY_ID"], sec["FLATSHARE_TESTS_SECRET"], timeout=60)
        convs = []
        for i in range(max(levels)):
            uid = make_user(db, tag, i)
            users.append(uid)
            r = boot.call("POST", "/v1/conversations", user_id=uid, body={"listing_id": lid, "text": "Bonjour"}, idem="lb-" + uuid.uuid4().hex)
            if r.status_code != 201:
                sys.exit(f"could not open a conversation: {r.status_code} {r.text[:300]}")
            convs.append((uid, r.json()["data"]["conversation"]["conversation_id"]))
        for kind in ([a.only] if a.only else ["search", "messages"]):
            for n in levels:
                took, res = run_level(base, sec, n, a.seconds, kind, convs)
                report["levels"].append({"kind": kind, "workers": n, "took_s": took, **res})
                for name, s in res.items():
                    print(f"{name:14} workers {n:3}  {s['requests']:6} req  {s['per_s']:7} /s  p50 {s['p50_ms']} ms  p95 {s['p95_ms']} ms"
                          f"  p99 {s['p99_ms']} ms  errors {s['errors'] or 0}", flush=True)
    finally:
        for k, v in keep.items():
            db.execute("update app.settings set value = %s where key = %s", (Jsonb(v), k))
        ids = users + [owner]
        db.execute("delete from app.users where id = any(%s::uuid[])", (ids,))
        db.execute("delete from app.listings where id = %s", (lid,))
        db.execute("delete from app.rate_counters where bucket like 'ip:%%'")
    report["finished_at"] = datetime.now(timezone.utc).isoformat(timespec="seconds")
    out = ROOT / "reports" / "load" / f"load-{datetime.now().strftime('%Y%m%d-%H%M%S')}.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(report, indent=2, ensure_ascii=False), encoding="utf-8")
    print(f"written {out.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
