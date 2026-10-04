#!/usr/bin/env python3
"""Phase 3 from the command line (profile and search). Runs in the tests container like
scripts/kb.py: `docker compose --profile test run --rm --no-deps tests python scripts/p3.py ...`.

  geo-fetch       query OpenStreetMap Nominatim once per gazetteer row not yet cached
                  (geo/places.csv -> geo/places_osm.csv), 1 request per 1.2 s, identified
                  User-Agent, results cached and committed (D-058, Nominatim usage policy)
  geo-load        load the cached places into app.places / app.place_names; rows far from
                  their city are reported and skipped
  geo-coverage    how many anchors of the P2 golden set the local gazetteer resolves
  seed            datasets (eval/datasets/manifest.json) and prompt registry (prompts/)
  seed-listings   synthetic listings (scripts/seed_listings.py), then embed them through the API
  fx              POST /v1/admin/fx/refresh and wait
  models          the LLMs installed in Ollama with their digests (read-only)
  eval            POST /v1/admin/eval/prompt-runs for a prompt, versions and models; wait
  report          docs/PROMPT_EVAL.md from the stored prompt runs, plus a JSON dump
  search-bench    N signed GET /v1/search requests; latency percentiles (spec 2.6: p95 < 1.5 s)

Environment: FS_API_BASE, FS_SECRETS_FILE, FS_TEST_DB_DSN (as for the contract tests),
FS_OLLAMA_URL (default http://ollama:11434), FS_GEO_CONTACT (optional contact for the User-Agent).
"""
from __future__ import annotations

import argparse
import csv
import json
import math
import os
import random
import subprocess
import sys
import time
from datetime import date, datetime, timezone
from pathlib import Path

import httpx
import psycopg

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
sys.path.insert(0, str(ROOT / "tests" / "client"))
import kb  # noqa: E402  (client(), dsn(), operator_id(), post_job(), seed_datasets())
import prompts as prompt_registry  # noqa: E402
import seed_listings  # noqa: E402

GEO = ROOT / "geo"
OSM_COLS = ["place_key", "status", "lat", "lon", "osm_type", "osm_id", "osm_class", "osm_kind", "display_name", "fetched_on", "query"]
COUNTRY = {"TN": "tn", "FR": "fr", "GB": "gb"}


# ---------------------------------------------------------------- gazetteer
def read_places():
    with open(GEO / "places.csv", encoding="utf-8", newline="") as f:
        rows = list(csv.DictReader(f))
    for r in rows:
        names = []
        for part in r["names"].split(" | "):
            tag, _, val = part.partition(":")
            if val.strip():
                names.append((tag.strip(), val.strip()))
        r["name_list"] = names
    return rows


def read_cache():
    p = GEO / "places_osm.csv"
    if not p.exists():
        return {}
    with open(p, encoding="utf-8", newline="") as f:
        return {r["place_key"]: r for r in csv.DictReader(f)}


def write_cache(cache: dict):
    with open(GEO / "places_osm.csv", "w", encoding="utf-8", newline="") as f:
        w = csv.DictWriter(f, fieldnames=OSM_COLS, lineterminator="\n")
        w.writeheader()
        for k in sorted(cache):
            w.writerow({c: cache[k].get(c, "") for c in OSM_COLS})


def geo_fetch(args):
    places = read_places()
    cache = read_cache()
    todo = [p for p in places if p["place_key"] not in cache or (args.retry and cache[p["place_key"]]["status"] != "ok")]
    contact = os.environ.get("FS_GEO_CONTACT", "repository owner")
    ua = f"FlatshareGazetteer/0.3 (student project, one-off cached build of ~270 place names; contact: {contact})"
    print(f"{len(places)} places, {len(cache)} cached, {len(todo)} to fetch (1 request per 1.2 s)")
    n_ok = n_missing = 0
    with httpx.Client(timeout=30, headers={"User-Agent": ua, "Accept-Language": "fr,en"}) as c:
        for i, p in enumerate(todo):
            params = {"q": p["query"], "format": "jsonv2", "limit": 1, "countrycodes": COUNTRY[p["jurisdiction"]]}
            try:
                r = c.get("https://nominatim.openstreetmap.org/search", params=params)
                if r.status_code != 200:
                    raise RuntimeError(f"HTTP {r.status_code}")
                res = r.json()
            except Exception as e:  # network or HTTP error: recorded, retried with --retry
                cache[p["place_key"]] = {"place_key": p["place_key"], "status": f"error: {e}"[:80], "fetched_on": date.today().isoformat(), "query": p["query"]}
                print(f"  {p['place_key']}: {e}")
                time.sleep(1.2)
                continue
            if res:
                x = res[0]
                cache[p["place_key"]] = {"place_key": p["place_key"], "status": "ok", "lat": x["lat"], "lon": x["lon"],
                                         "osm_type": x.get("osm_type", ""), "osm_id": x.get("osm_id", ""),
                                         "osm_class": x.get("category", x.get("class", "")), "osm_kind": x.get("type", ""),
                                         "display_name": x.get("display_name", "")[:200], "fetched_on": date.today().isoformat(),
                                         "query": p["query"]}
                n_ok += 1
            else:
                cache[p["place_key"]] = {"place_key": p["place_key"], "status": "not_found", "fetched_on": date.today().isoformat(), "query": p["query"]}
                n_missing += 1
            if (i + 1) % 25 == 0:
                write_cache(cache)
                print(f"  {i + 1}/{len(todo)}")
            time.sleep(1.2)
    write_cache(cache)
    total = sum(1 for v in cache.values() if v["status"] == "ok")
    print(f"fetched: {n_ok} found, {n_missing} not found; cache: {total} of {len(places)} places with coordinates -> geo/places_osm.csv")


def geo_load(args):
    places = read_places()
    cache = read_cache()
    cities = {}
    for p in places:
        c = cache.get(p["place_key"])
        if p["kind"] == "city" and c and c["status"] == "ok":
            cities[(p["jurisdiction"], p["city"])] = (float(c["lat"]), float(c["lon"]))
    loaded, skipped = [], []
    with psycopg.connect(kb.dsn()) as conn:
        for p in places:
            c = cache.get(p["place_key"])
            if not c or c["status"] != "ok":
                skipped.append((p["place_key"], c["status"] if c else "not fetched"))
                continue
            lat, lon = float(c["lat"]), float(c["lon"])
            city = cities.get((p["jurisdiction"], p["city"]))
            if city and p["kind"] != "city":
                d = seed_listings.haversine_m(lat, lon, *city) / 1000
                if d > args.max_km:
                    skipped.append((p["place_key"], f"{d:.0f} km from {p['city']}: {c['display_name'][:70]}"))
                    continue
            pid = conn.execute(
                """insert into app.places (place_key, jurisdiction_code, kind, name, city, location, source, osm_type, osm_id,
                                            display_name, fetched_on)
                   values (%s, %s, %s, %s, %s, st_setsrid(st_makepoint(%s, %s), 4326)::geography, 'osm-nominatim', %s, %s, %s, %s)
                   on conflict (place_key) do update set kind = excluded.kind, name = excluded.name, city = excluded.city,
                     location = excluded.location, osm_type = excluded.osm_type, osm_id = excluded.osm_id,
                     display_name = excluded.display_name, fetched_on = excluded.fetched_on, active = true
                   returning id""",
                (p["place_key"], p["jurisdiction"], p["kind"], p["name_list"][0][1], p["city"], lon, lat, c["osm_type"],
                 int(c["osm_id"]) if c["osm_id"] else None, c["display_name"], c["fetched_on"])).fetchone()[0]
            conn.execute("delete from app.place_names where place_id = %s", (pid,))
            seen = set()
            for tag, name in p["name_list"]:
                if name in seen:
                    continue
                seen.add(name)
                conn.execute("insert into app.place_names (place_id, name, lang) values (%s, %s, %s)", (pid, name, tag))
            loaded.append(p["place_key"])
        keys = [p["place_key"] for p in places]
        conn.execute("update app.places set active = false where source = 'osm-nominatim' and not (place_key = any(%s))", (keys,))
        conn.execute("update app.places set active = false where place_key = any(%s)", ([k for k, _ in skipped],))
        conn.commit()
    print(f"places loaded: {len(loaded)}; skipped: {len(skipped)}")
    for k, why in skipped:
        print(f"  skipped {k}: {why}")


def geo_coverage(args):
    rows = [json.loads(l) for l in (ROOT / "eval" / "datasets" / "p2_profile_v1.jsonl").read_text(encoding="utf-8").splitlines() if l.strip()]
    res = {"found": [], "ambiguous": [], "not_found": []}
    with psycopg.connect(kb.dsn()) as conn:
        for r in rows:
            g = r["gold"]["profile"]
            if not g["anchor_label"]:
                continue
            j = g["jurisdiction_code"] or r["context"]["jurisdiction"]
            out = conn.execute("select app.geocode(%s, %s)", (g["anchor_label"], j)).fetchone()[0]
            res[out["status"]].append((r["id"], g["anchor_label"], out["place"]["place_key"] if out.get("place") else
                                       [c["place_key"] for c in out["candidates"][:3]]))
    n = sum(len(v) for v in res.values())
    print(f"P2 gold anchors: {n}; found {len(res['found'])}, ambiguous {len(res['ambiguous'])}, not found {len(res['not_found'])}")
    for k in ("ambiguous", "not_found", "found"):
        for x in res[k]:
            print(f"  {k:9s} {x[0]} {x[1]!r} -> {x[2]}")
    out = ROOT / "reports" / "eval" / "geo-coverage.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps({"date": date.today().isoformat(), "total": n, **{k: v for k, v in res.items()}}, ensure_ascii=False, indent=1))


# ---------------------------------------------------------------- seed
def seed(args):
    with psycopg.connect(kb.dsn()) as conn:
        kb.seed_datasets(conn, args.force)
        conn.commit()
        errs = prompt_registry.check()
        if errs:
            sys.exit("\n".join(errs))
        lines = prompt_registry.sync(conn)
        conn.commit()
    print("\n".join(lines) if lines else "prompt registry up to date")


def seed_listings_cmd(args):
    with psycopg.connect(kb.dsn()) as conn:
        rows = conn.execute(
            """select p.place_key, p.jurisdiction_code, p.kind, p.name, p.city, st_y(p.location::geometry), st_x(p.location::geometry),
                      (select jsonb_object_agg(lang, name) from (select distinct on (lang) lang, name from app.place_names
                        where place_id = p.id order by lang, name) n)
               from app.places p where p.active and p.source = 'osm-nominatim' order by p.place_key""").fetchall()
        places = [{"place_key": r[0], "jurisdiction": r[1], "kind": r[2], "name": r[3], "city": r[4], "lat": r[5], "lng": r[6],
                   "names": r[7] or {}} for r in rows]
        if not places:
            sys.exit("no places loaded: run geo-fetch and geo-load first")
        listings = seed_listings.generate(places)
        stats = seed_listings.upsert(conn, listings)
        conn.commit()
        dist = conn.execute("""select jurisdiction_code, count(*), count(*) filter (where rent_period = 'week'),
                                      count(distinct city) from app.listings where source = 'synthetic' group by 1 order by 1""").fetchall()
        share = conn.execute("select count(*) filter (where is_synthetic), count(*) from app.listings where status = 'published'").fetchone()
    print(f"synthetic listings: {stats}")
    for j, n, w, c in dist:
        print(f"  {j}: {n} listings ({w} weekly rents) in {c} cities")
    print(f"published listings: {share[1]}, synthetic: {share[0]} ({100.0 * share[0] / max(share[1], 1):.0f}%)")
    if not args.no_embed:
        job = kb.post_job("/v1/admin/listings/embed", {}, args.timeout, "listings_embed")
        print(f"embedding job: {job.get('status')} {job.get('output')}")
        if job.get("status") != "succeeded":
            sys.exit(1)


def fx(args):
    job = kb.post_job("/v1/admin/fx/refresh", {}, 120, "fx_refresh", max_age_h=0.5)
    print(f"fx job: {job.get('status')} {json.dumps(job.get('output'))} {job.get('error') or ''}")
    if job.get("status") != "succeeded":
        sys.exit(1)


def models(args):
    base = os.environ.get("FS_OLLAMA_URL", "http://ollama:11434")
    r = httpx.get(f"{base}/api/tags", timeout=10).json()
    for m in sorted(r.get("models", []), key=lambda x: x["name"]):
        d = m.get("details", {})
        print(f"{m['name']:22s} digest {m.get('digest', '')[:12]}  size {m.get('size', 0) / 1e9:.2f} GB  "
              f"{d.get('parameter_size', '')} {d.get('quantization_level', '')} {d.get('family', '')}")


def run_eval(args):
    body = {"prompt": args.prompt, "versions": [int(v) for v in args.versions.split(",")], "git_sha": kb.git_sha()}
    if args.models:
        body["models"] = args.models.split(",")
    if args.limit:
        body["limit"] = args.limit
    if args.label:
        body["label"] = args.label
    job = kb.post_job("/v1/admin/eval/prompt-runs", body, args.timeout, "eval_prompts", max_age_h=8)
    print(f"job {job.get('job_id')}: {job.get('status')} {job.get('error') or ''}")
    for r in (job.get("output") or {}).get("runs", []):
        print("  " + "  ".join(f"{k} {v}" for k, v in r.items()))
    if job.get("status") != "succeeded":
        sys.exit(1)


def report(args):
    sys.path.insert(0, str(ROOT / "eval" / "runners"))
    import prompt_report
    with psycopg.connect(kb.dsn()) as conn:
        data = prompt_report.load(conn)
    stamp = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
    dump = ROOT / "reports" / "eval" / f"prompts-{stamp}.json"
    dump.parent.mkdir(parents=True, exist_ok=True)
    dump.write_text(json.dumps(data, ensure_ascii=False, default=str), encoding="utf-8")
    Path(args.out).write_text(prompt_report.render(data), encoding="utf-8")
    print(f"wrote {dump.relative_to(ROOT)} and {Path(args.out).relative_to(ROOT)}")


# ---------------------------------------------------------------- search latency
BENCH_QUERIES = {
    "TN": ["chambre meublée près de la fac", "colocation calme Ennasr", "room near INSAT", "bit lel kra fi lmarsa",
           "غرفة للكراء قرب الجامعة", "appartement à partager La Marsa", "chambre avec wifi et climatisation", "studio Lac 2",
           "colocation étudiante Manouba", "room with balcony Ariana"],
    "FR": ["chambre en colocation Paris 13e", "coloc calme près de Jussieu", "room near La Défense", "chambre meublée Lyon Part-Dieu",
           "colocation étudiante Villeurbanne"],
    "GB": ["double room Camden", "room near UCL bills included", "flatshare Manchester Fallowfield", "quiet room Islington",
           "room near King's Cross"],
}
BENCH_PLACES = {"TN": ["Ennasr", "La Marsa", "INSAT", "Lafayette", "El Menzah 6"], "FR": ["Paris 13e", "Jussieu", "Villeurbanne"],
                "GB": ["Camden", "UCL", "Fallowfield"]}
BENCH_BUDGET = {"TN": (300000, 900000), "FR": (40000, 120000), "GB": (50000, 130000)}


def bench_requests(n: int, seed: int = 20261004):
    rng = random.Random(seed)
    out = []
    for i in range(n):
        j = rng.choices(["TN", "FR", "GB"], weights=[6, 2, 2])[0]
        p = {"jurisdiction": j, "limit": "20"}
        shape = rng.random()
        if shape < 0.7:
            p["q"] = rng.choice(BENCH_QUERIES[j])
        if rng.random() < 0.6:
            lo, hi = BENCH_BUDGET[j]
            p["max_rent"] = str(rng.randrange(lo, hi, 10000))
        if rng.random() < 0.4:
            p["near"] = rng.choice(BENCH_PLACES[j])
            p["radius_m"] = str(rng.choice([2000, 5000, 10000]))
        out.append(p)
    return out


def search_bench(args):
    c = kb.client()
    with psycopg.connect(kb.dsn()) as conn:
        uid = conn.execute(
            """insert into app.users (external_auth_id, display_name, role, jurisdiction_code) values ('local-bench-user', 'Search benchmark', 'user', 'TN')
               on conflict (external_auth_id) do update set role = 'user' returning id""").fetchone()[0]
        for purpose in ("terms", "privacy"):
            conn.execute("insert into app.consents (user_id, purpose, granted, policy_version, source) values (%s, %s, true, 'bench', 'script')",
                         (uid, purpose))
        conn.commit()
        n_listings = conn.execute("select count(*) from app.listings where status = 'published'").fetchone()[0]
        lim = dict(conn.execute("""select key, value::text from app.settings
                                   where key in ('gateway.rate_limit_user_per_min', 'gateway.rate_limit_ip_per_min')""").fetchall())
    uid = str(uid)
    # One user from one IP: stay under the gateway limits (fixed one-minute windows), with a 10% margin.
    # Without this, 200 back-to-back requests got 429 RATE_LIMITED (F-049).
    per_min = min(int(str(lim.get("gateway.rate_limit_user_per_min", "60")).strip('"')),
                  int(str(lim.get("gateway.rate_limit_ip_per_min", "120")).strip('"')))
    interval = args.interval if args.interval is not None else 60.0 / per_min * 1.1
    reqs = bench_requests(args.warmup + args.n)
    print(f"{len(reqs)} requests, one every {interval:.2f} s (limit {per_min}/min): about {len(reqs) * interval / 60:.1f} min", flush=True)
    t_start = datetime.now(timezone.utc)
    rows = []
    next_at = time.perf_counter()
    for i, p in enumerate(reqs):
        wait = next_at - time.perf_counter()
        if wait > 0:
            time.sleep(wait)                          # pacing is outside the timed section
        next_at = time.perf_counter() + interval
        if i == args.warmup:
            t_start = datetime.now(timezone.utc)      # ai.executions rows of the measured requests only
        t0 = time.perf_counter()
        r = c.call("GET", "/v1/search", user_id=uid, params=p)
        ms = (time.perf_counter() - t0) * 1000
        if i < args.warmup:
            continue
        body = r.json()
        t = (body.get("meta") or {}).get("timings") or {}
        rows.append({"status": r.status_code, "client_ms": round(ms, 1), "server_ms": (body.get("meta") or {}).get("latency_ms"),
                     "embed_ms": t.get("embed_ms"), "db_ms": t.get("db_ms"), "search_ms": t.get("total_ms"),
                     "count": (body.get("data") or {}).get("count"), "mode": (body.get("data") or {}).get("mode"),
                     "warnings": (body.get("data") or {}).get("warnings"), "params": p,
                     "error": (body.get("error") or {}).get("code")})
    ok = [x for x in rows if x["status"] == 200]

    def pct(xs, q):
        xs = sorted(v for v in xs if v is not None)
        return xs[max(0, math.ceil(q / 100 * len(xs)) - 1)] if xs else None

    with psycopg.connect(kb.dsn()) as conn:
        ex = conn.execute("""select count(*), percentile_disc(0.5) within group (order by latency_ms),
                                    percentile_disc(0.95) within group (order by latency_ms), max(latency_ms)
                             from ai.executions where workflow = 'wf.api.search' and started_at >= %s and user_id = %s""",
                          (t_start, uid)).fetchone()
    summary = {"date": datetime.now(timezone.utc).isoformat(timespec="seconds"), "requests": len(rows), "ok": len(ok),
               "warmup": args.warmup, "published_listings": n_listings, "interval_s": round(interval, 3),
               "load": "sequential, one request at a time, paced under the rate limit",
               "client_ms": {"p50": pct([x["client_ms"] for x in ok], 50), "p95": pct([x["client_ms"] for x in ok], 95), "max": pct([x["client_ms"] for x in ok], 100)},
               "server_ms": {"p50": pct([x["server_ms"] for x in ok], 50), "p95": pct([x["server_ms"] for x in ok], 95), "max": pct([x["server_ms"] for x in ok], 100)},
               "embed_ms_p95": pct([x["embed_ms"] for x in ok if x["mode"] == "hybrid"], 95),
               "db_ms": {"p50": pct([x["db_ms"] for x in ok], 50), "p95": pct([x["db_ms"] for x in ok], 95)},
               "ai_executions": {"n": ex[0], "p50": ex[1], "p95": ex[2], "max": ex[3]},
               "by_mode": {m: {"n": len([x for x in ok if x["mode"] == m]),
                               "server_p95": pct([x["server_ms"] for x in ok if x["mode"] == m], 95)} for m in ("hybrid", "filters")},
               "empty_results": len([x for x in ok if not x["count"]]), "errors": [x for x in rows if x["status"] != 200][:5]}
    stamp = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
    out = ROOT / "reports" / "eval" / f"search-bench-{stamp}.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps({"summary": summary, "requests": rows}, ensure_ascii=False, indent=1), encoding="utf-8")
    print(json.dumps(summary, indent=1))
    print(f"wrote {out.relative_to(ROOT)}")
    if len(ok) != len(rows):
        sys.exit(1)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    s = sub.add_parser("geo-fetch"); s.add_argument("--retry", action="store_true", help="fetch again rows not found or failed")
    s = sub.add_parser("geo-load"); s.add_argument("--max-km", type=float, default=40.0)
    sub.add_parser("geo-coverage")
    s = sub.add_parser("seed"); s.add_argument("--force", action="store_true")
    s = sub.add_parser("seed-listings"); s.add_argument("--no-embed", action="store_true"); s.add_argument("--timeout", type=int, default=1800)
    sub.add_parser("fx")
    sub.add_parser("models")
    s = sub.add_parser("eval")
    s.add_argument("--prompt", required=True); s.add_argument("--versions", required=True); s.add_argument("--models")
    s.add_argument("--limit", type=int); s.add_argument("--label"); s.add_argument("--timeout", type=int, default=4 * 3600)
    s = sub.add_parser("report"); s.add_argument("--out", default=str(ROOT / "docs" / "PROMPT_EVAL.md"))
    s = sub.add_parser("search-bench"); s.add_argument("--n", type=int, default=200); s.add_argument("--warmup", type=int, default=10)
    s.add_argument("--interval", type=float, help="seconds between request starts (default: from the gateway rate limits)")
    a = ap.parse_args()
    {"geo-fetch": geo_fetch, "geo-load": geo_load, "geo-coverage": geo_coverage, "seed": seed, "seed-listings": seed_listings_cmd,
     "fx": fx, "models": models, "eval": run_eval, "report": report, "search-bench": search_bench}[a.cmd](a)


if __name__ == "__main__":
    main()
