#!/usr/bin/env python3
"""Knowledge base and retrieval evaluation, from the command line (runs in the
tests container: `docker compose --profile test run --rm --no-deps tests python scripts/kb.py ...`).

  seed        load kb/packs/*/sources.csv into kb.sources and eval/datasets into eval.*
  ingest      POST /v1/admin/kb/ingest for a jurisdiction and wait for the job
  export      write the current documents to kb/packs/<CODE>/documents/<source_key>/ (git-ignored)
  check-gold  resolve every gold span of a dataset against the current documents
  eval        POST /v1/admin/eval/runs, wait, then write docs/RETRIEVAL_EVAL.md
  report      rewrite docs/RETRIEVAL_EVAL.md for an existing evaluation job

The API calls are signed with the tests key and an operator account with the
admin role (external_auth_id "local-ops-admin", created on first use).
Environment: FS_API_BASE, FS_SECRETS_FILE, FS_TEST_DB_DSN (as for the contract tests).
"""
from __future__ import annotations

import argparse
import csv
import json
import os
import subprocess
import sys
import time
import uuid
from pathlib import Path

import psycopg

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tests" / "client"))
sys.path.insert(0, str(ROOT / "eval" / "runners"))
from fsclient import Client  # noqa: E402

SOURCE_TYPES = {"primary_law", "regulator", "government_guide", "ngo", "commercial_guide", "blog", "internal"}


def dsn():
    d = os.environ.get("FS_TEST_DB_DSN")
    if not d:
        sys.exit("FS_TEST_DB_DSN is not set")
    return d


def client():
    vals = {}
    for line in Path(os.environ.get("FS_SECRETS_FILE", "secrets/api-clients.env")).read_text().splitlines():
        if "=" in line and not line.startswith("#"):
            k, v = line.split("=", 1)
            vals[k.strip()] = v.strip()
    return Client(os.environ.get("FS_API_BASE", "http://proxy:8080"), vals["FLATSHARE_TESTS_KEY_ID"],
                  vals["FLATSHARE_TESTS_SECRET"], timeout=60)


def operator_id(conn) -> str:
    row = conn.execute("""insert into app.users (external_auth_id, display_name, role)
                          values ('local-ops-admin', 'Local operator (scripts/kb.py)', 'admin')
                          on conflict (external_auth_id) do update set role = 'admin' returning id""").fetchone()
    return str(row[0])


# ---------------------------------------------------------------- seed
def read_sources(pack_dir: Path):
    code = None if pack_dir.name == "GLOBAL" else pack_dir.name
    rows = list(csv.DictReader((pack_dir / "sources.csv").open(encoding="utf-8")))
    out, errors = [], []
    for i, r in enumerate(rows, start=2):
        if r["source_type"] not in SOURCE_TYPES:
            errors.append(f"{pack_dir.name}/sources.csv line {i}: source_type {r['source_type']!r}")
        if not r["reliability"].isdigit() or not 1 <= int(r["reliability"]) <= 5:
            errors.append(f"{pack_dir.name}/sources.csv line {i}: reliability {r['reliability']!r}")
        if not r["url"].startswith(("http://", "https://")):
            errors.append(f"{pack_dir.name}/sources.csv line {i}: url")
        fetch = {"format": r["format"] or None}
        if r.get("extract"):
            try:
                ex = json.loads(r["extract"])
            except json.JSONDecodeError as e:
                errors.append(f"{pack_dir.name}/sources.csv line {i}: extract is not JSON ({e})")
                ex = {}
            unknown = set(ex) - {"select", "start_at", "end_at", "min_chars", "keep_boilerplate", "require_select"}
            if unknown:
                errors.append(f"{pack_dir.name}/sources.csv line {i}: unknown extract keys {sorted(unknown)}")
            fetch.update(ex)
        out.append({**r, "jurisdiction_code": code, "fetch_config": fetch})
    keys = [r["source_key"] for r in out]
    dup = {k for k in keys if keys.count(k) > 1}
    if dup:
        errors.append(f"{pack_dir.name}: duplicate source_key {sorted(dup)}")
    return out, errors


def seed(args):
    packs = sorted(p for p in (ROOT / "kb" / "packs").iterdir() if (p / "sources.csv").exists())
    all_rows, errors = [], []
    for p in packs:
        rows, errs = read_sources(p)
        all_rows += rows
        errors += errs
    if errors:
        sys.exit("sources.csv errors:\n  " + "\n  ".join(errors))
    with psycopg.connect(dsn(), autocommit=False) as conn:
        for r in all_rows:
            conn.execute("""
              insert into kb.sources (source_key, jurisdiction_code, title, url, publisher, source_type, reliability,
                                      language, license, notes, fetch_config, cite_as, status)
              values (%(source_key)s, %(jurisdiction_code)s, %(title)s, %(url)s, %(publisher)s, %(source_type)s,
                      %(reliability)s::smallint, %(language)s, %(license)s, %(notes)s, %(fetch)s::jsonb, nullif(%(cite_as)s, ''), 'active')
              on conflict (source_key) do update set
                jurisdiction_code = excluded.jurisdiction_code, title = excluded.title, url = excluded.url,
                publisher = excluded.publisher, source_type = excluded.source_type, reliability = excluded.reliability,
                language = excluded.language, license = excluded.license, notes = excluded.notes,
                fetch_config = excluded.fetch_config, cite_as = excluded.cite_as,
                status = case when kb.sources.status = 'removed' then 'active' else kb.sources.status end""",
                         {**r, "fetch": json.dumps(r["fetch_config"])})
        keys = [r["source_key"] for r in all_rows]
        removed = conn.execute("""update kb.sources set status = 'removed'
                                  where source_key is not null and source_key not like 'test-%%'
                                    and not (source_key = any(%s)) and status <> 'removed' returning source_key""",
                               (keys,)).fetchall()
        print(f"sources: {len(all_rows)} upserted from {len(packs)} packs; marked removed: {[r[0] for r in removed]}")
        seed_datasets(conn, args.force)
        conn.commit()


def seed_datasets(conn, force=False):
    manifest = ROOT / "eval" / "datasets" / "manifest.json"
    if not manifest.exists():
        print("datasets: no manifest")
        return
    for d in json.loads(manifest.read_text(encoding="utf-8")):
        lines = [json.loads(l) for l in (ROOT / "eval" / "datasets" / d["file"]).read_text(encoding="utf-8").splitlines() if l.strip()]
        ids = [q["id"] for q in lines]
        if len(set(ids)) != len(ids):
            sys.exit(f"{d['file']}: duplicate query ids")
        ds = conn.execute("""insert into eval.datasets (name, kind, version, notes) values (%s, %s, %s, %s)
                             on conflict (name, version) do update set notes = excluded.notes returning id""",
                          (d["name"], d["kind"], d["version"], d.get("notes"))).fetchone()[0]
        current = {r[0]: (r[1], r[2], r[3], r[4], r[5]) for r in conn.execute(
            "select external_id, query, language, jurisdiction_code, gold, tags from eval.queries where dataset_id = %s", (ds,))}
        wanted = {q["id"]: (q["query"], q.get("language"), q.get("jurisdiction"), q["gold"], q.get("tags", [])) for q in lines}
        has_runs = conn.execute("select count(*) from eval.runs where dataset_id = %s", (ds,)).fetchone()[0] > 0
        changed = {k for k in wanted if k not in current or tuple(current[k]) != wanted[k]} | (set(current) - set(wanted))
        if changed and has_runs and not force:
            sys.exit(f"dataset {d['name']} v{d['version']} has evaluation runs and its queries changed "
                     f"({len(changed)} ids); bump the version or pass --force")
        for qid, (query, lang, jur, gold, tags) in wanted.items():
            conn.execute("""insert into eval.queries (dataset_id, external_id, query, language, jurisdiction_code, gold, tags)
                            values (%s, %s, %s, %s, %s, %s::jsonb, %s)
                            on conflict (dataset_id, external_id) do update set query = excluded.query,
                              language = excluded.language, jurisdiction_code = excluded.jurisdiction_code,
                              gold = excluded.gold, tags = excluded.tags""",
                         (ds, qid, query, lang, jur, json.dumps(gold), tags))
        gone = set(current) - set(wanted)
        if gone:
            conn.execute("delete from eval.queries where dataset_id = %s and external_id = any(%s)", (ds, list(gone)))
        print(f"dataset {d['name']} v{d['version']}: {len(wanted)} queries ({len(changed)} new or changed, {len(gone)} removed)")


# ---------------------------------------------------------------- jobs
def wait_job(c: Client, uid: str, job_id: str, timeout_s: int):
    t0 = time.time()
    last = None
    misses = 0
    seen = 0
    while time.time() - t0 < timeout_s:
        r = c.call("GET", f"/v1/jobs/{job_id}", user_id=uid)
        if r.status_code != 200:
            misses += 1
            print(f"  poll: HTTP {r.status_code} {r.text[:200]}")
            if r.status_code == 404 and misses >= 6:
                sys.exit(f"GET /v1/jobs/{job_id} keeps answering 404: the job route is not reachable through the proxy "
                         "(see docs/FAILURES.md F-026). The job itself may still be running in n8n.")
        else:
            misses = 0
            d = r.json()["data"]
            if d["status"] != last:
                print(f"  {time.time() - t0:7.1f}s  job {d['status']}")
                last = d["status"]
            seen = progress(job_id, seen, t0)
            if d["status"] in ("succeeded", "failed", "cancelled"):
                return d
        time.sleep(int(os.environ.get("FS_POLL_S", "10")))
    sys.exit(f"job {job_id} did not finish within {timeout_s} s")


def progress(job_id: str, seen: int, t0: float) -> int:
    """Print what the job finished since the last poll: one line per source
    (ingestion) or per configuration (evaluation). Read-only database queries."""
    try:
        with psycopg.connect(dsn(), autocommit=True) as conn:
            rows = conn.execute("""
              select l.id, l.source_key || ': ' || l.status || ' (' || l.step || ')'
                       || coalesce(', ' || round(l.ms / 1000.0) || ' s', '')
                       || coalesce(' ' || (l.detail->>'error'), '')
              from kb.ingest_log l where l.job_id = %s and l.id > %s
              union all
              select 0, 'run ' || (r.config->>'strategy') || ' / ' || (r.config->>'model') || ' / '
                       || (r.config->>'mode') || ': ' || r.status
              from eval.runs r where r.job_id = %s and r.status <> 'running'
              order by 1""", (job_id, seen, job_id)).fetchall()
    except Exception as e:                       # progress is informative only
        print(f"  (progress not available: {e.__class__.__name__})")
        return seen
    runs = [t for i, t in rows if i == 0]
    for i, text in rows:
        if i:
            print(f"  {time.time() - t0:7.1f}s  {text}")
            seen = max(seen, i)
    if runs and len(runs) != getattr(progress, "_runs", 0):
        print(f"  {time.time() - t0:7.1f}s  {len(runs)} evaluation runs finished; last: {runs[-1]}")
        progress._runs = len(runs)
    return seen


def post_job(path: str, body: dict, timeout_s: int, job_type: str, max_age_h: float = 3.0):
    """Start a job, or wait for one of the same type that is already queued or running
    (for example after the script was stopped while n8n kept working). A job older than
    max_age_h is assumed dead (n8n restarted; no reaper before phase 4) and marked failed."""
    c = client()
    with psycopg.connect(dsn(), autocommit=True) as conn:
        uid = operator_id(conn)
        active = conn.execute("""select id, extract(epoch from now() - coalesce(started_at, created_at)) / 3600
                                 from app.jobs where type = %s and status in ('queued', 'running')
                                   and input->>'jurisdiction' = %s
                                 order by created_at""", (job_type, body.get("jurisdiction"))).fetchall()
        for jid, age_h in active:
            if age_h > max_age_h:
                conn.execute("""update app.jobs set status = 'failed', finished_at = now(),
                                  error = 'abandoned: still running after ' || %s || ' h; marked by scripts/kb.py'
                                where id = %s and status in ('queued', 'running')""", (round(age_h, 1), jid))
                print(f"job {jid} ({job_type}) was still marked running after {age_h:.1f} h: marked failed (abandoned)")
            else:
                print(f"job {jid} ({job_type}) is already running for {age_h * 60:.0f} min: waiting for it instead of starting another")
                return wait_job(c, uid, str(jid), timeout_s)
    r = c.call("POST", path, body=body, user_id=uid, idem="kb-" + uuid.uuid4().hex)
    if r.status_code != 202:
        sys.exit(f"{path}: HTTP {r.status_code} {r.text[:500]}")
    job_id = r.json()["data"]["job_id"]
    print(f"{path}: job {job_id} accepted")
    return wait_job(c, uid, job_id, timeout_s)


def ingest(args):
    body = {"jurisdiction": args.jurisdiction, "include_global": not args.no_global, "force": args.force}
    if args.sources:
        body["sources"] = args.sources.split(",")
    t0 = time.time()
    job = post_job("/v1/admin/kb/ingest", body, args.timeout, "kb_ingest")
    out = job.get("output") or {}
    print(f"ingest {job['status']} in {time.time() - t0:.0f} s: {json.dumps(out.get('counts'))}")
    for s in out.get("sources", []):
        ch = s.get("chunks") or {}
        desc = ", ".join(f"{k}: {v.get('chunks')} chunks" for k, v in ch.items()) if ch else ""
        print(f"  {s['status']:8} {s['source_key']:34} {s.get('action') or s.get('step') or ''} {desc} "
              f"{s.get('error') or s.get('reason') or ''}")
    if job.get("error"):
        print("job error:", job["error"])
    return 0 if job["status"] == "succeeded" else 2


def git_sha():
    try:
        return subprocess.run(["git", "-c", "safe.directory=*", "-C", str(ROOT), "rev-parse", "--short", "HEAD"], capture_output=True,
                              text=True, timeout=10).stdout.strip() or None
    except Exception:
        return None


def run_eval(args):
    body = {"dataset": args.dataset, "version": args.version, "jurisdiction": args.jurisdiction, "k": args.k}
    sha = args.git_sha or git_sha()
    if sha:
        body["git_sha"] = sha
    job = post_job("/v1/admin/eval/runs", body, args.timeout, "eval_retrieval")
    out = job.get("output") or {}
    for r in out.get("runs", []):
        c, s = r["config"], r["summary"] or {}
        print(f"  {c['strategy']:20} {c['model']:22} {c['mode']:8} hit@5 {s.get('hit@5')}  mrr {s.get('mrr')}  "
              f"recall@10 {s.get('recall@10')}  p95 {s.get('latency_ms_p95')} ms")
    if job["status"] != "succeeded":
        print("job error:", job.get("error"))
        return 2
    return report_for(job["job_id"], args.out)


def report_for(job_id, out):
    """Write the report, and a JSON dump of the evaluation (reports/eval/<job>.json) for failure analysis."""
    import report  # eval/runners/report.py
    with psycopg.connect(dsn()) as conn:
        if job_id == "latest":
            row = conn.execute("select id from app.jobs where type = 'eval_retrieval' and status = 'succeeded' "
                               "order by created_at desc limit 1").fetchone()
            if not row:
                sys.exit("no succeeded evaluation job")
            job_id = str(row[0])
        data = report.load(conn, job_id)
        ds = data[0][1]
        gold = {qid: g for qid, g in conn.execute(
            """select q.external_id, eval.resolve_gold(q.gold) from eval.queries q join eval.datasets d on d.id = q.dataset_id
               where d.name = %s and d.version = %s""", (ds["dataset"], ds["version"])).fetchall()}
    dump = ROOT / "reports" / "eval" / f"{job_id}.json"
    try:
        dump.parent.mkdir(parents=True, exist_ok=True)
        dump.write_text(json.dumps(report.to_json(data, gold), ensure_ascii=False, default=str), encoding="utf-8")
        print("wrote", dump)
    except OSError as e:                      # reports/ not mounted writable: the report still gets written
        print("dump not written:", e)
    notes_file = ROOT / "eval" / "datasets" / f"{ds['dataset']}_v{ds['version']}_notes.json"
    notes = json.loads(notes_file.read_text(encoding="utf-8")) if notes_file.exists() else {}
    tried_file = ROOT / "eval" / "reports" / "tried.md"
    text = report.render(*data, notes=notes, tried=tried_file.read_text(encoding="utf-8") if tried_file.exists() else "")
    Path(out).write_text(text, encoding="utf-8")
    print("wrote", out)
    return 0


# ---------------------------------------------------------------- export, gold
def export(args):
    with psycopg.connect(dsn()) as conn:
        rows = conn.execute("""
          select s.source_key, coalesce(s.jurisdiction_code, 'GLOBAL'), s.url, s.title, s.publisher, s.source_type,
                 s.reliability, s.language, d.version, d.content, d.content_hash, d.extractor, d.char_count, d.metadata,
                 r.bytes, r.sha256, r.content_type, r.fetched_at,
                 (select jsonb_object_agg(strategy, n) from (select strategy, count(*) n from kb.chunks
                    where document_id = d.id group by 1) x) as chunks
          from kb.documents d join kb.sources s on s.id = d.source_id
          left join kb.raw_fetches r on r.id = d.raw_fetch_id
          where d.status = 'current' order by 1""").fetchall()
    for (key, code, url, title, pub, stype, rel, lang, ver, content, chash, extractor, chars, meta,
         raw, rsha, ctype, fetched, chunks) in rows:
        d = ROOT / "kb" / "packs" / code / "documents" / key
        d.mkdir(parents=True, exist_ok=True)
        (d / "clean.txt").write_text(content, encoding="utf-8")
        ext = "pdf" if "pdf" in (ctype or "") else "html"
        if raw is not None:
            (d / f"raw.{ext}").write_bytes(bytes(raw))
        (d / "meta.json").write_text(json.dumps({
            "source_key": key, "url": url, "title": title, "publisher": pub, "source_type": stype, "reliability": rel,
            "language": lang, "version": ver, "content_sha256": chash, "raw_sha256": rsha, "content_type": ctype,
            "retrieved_at": fetched.isoformat() if fetched else None, "extractor": extractor, "char_count": chars,
            "extractor_metadata": meta, "chunks": chunks}, ensure_ascii=False, indent=2), encoding="utf-8")
        print(f"  {key:34} v{ver} {chars:>9,} chars  {json.dumps(chunks)}")
    print(f"exported {len(rows)} documents under kb/packs/*/documents/")


def check_gold(args):
    with psycopg.connect(dsn()) as conn:
        rows = conn.execute("""select q.external_id, eval.resolve_gold(q.gold) from eval.queries q
                               join eval.datasets d on d.id = q.dataset_id
                               where d.name = %s and d.version = %s order by 1""", (args.dataset, args.version)).fetchall()
    bad = 0
    for qid, spans in rows:
        for s in spans:
            if not s["found"] or s["ambiguous"]:
                bad += 1
                print(f"  {qid}: {s['source_key']} found={s['found']} ambiguous={s['ambiguous']}")
    print(f"{len(rows)} queries, {sum(len(s) for _, s in rows)} gold spans, {bad} problems")
    return 1 if bad else 0


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    s = sub.add_parser("seed"); s.add_argument("--force", action="store_true")
    s = sub.add_parser("ingest"); s.add_argument("--jurisdiction", default="TN"); s.add_argument("--sources")
    s.add_argument("--no-global", action="store_true"); s.add_argument("--force", action="store_true")
    s.add_argument("--timeout", type=int, default=7200)
    sub.add_parser("export")
    for name in ("check-gold", "eval"):
        s = sub.add_parser(name); s.add_argument("--dataset", default="tn_retrieval"); s.add_argument("--version", type=int, default=1)
        if name == "eval":
            s.add_argument("--jurisdiction", default="TN"); s.add_argument("--k", type=int, default=10)
            s.add_argument("--timeout", type=int, default=3600); s.add_argument("--git-sha")
            s.add_argument("--out", default=str(ROOT / "docs" / "RETRIEVAL_EVAL.md"))
    s = sub.add_parser("report"); s.add_argument("--job", default="latest", help="evaluation job id, or latest"); s.add_argument("--out", default=str(ROOT / "docs" / "RETRIEVAL_EVAL.md"))
    a = ap.parse_args()
    fn = {"seed": seed, "ingest": ingest, "export": export, "check-gold": check_gold, "eval": run_eval,
          "report": lambda a: report_for(a.job, a.out)}[a.cmd]
    sys.exit(fn(a) or 0)


if __name__ == "__main__":
    main()
