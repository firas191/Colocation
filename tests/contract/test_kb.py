"""Phase 2 contract tests: knowledge-base ingestion, job status and retrieval
evaluation through the API, on synthetic fixtures (tests/fixtures/kb) served by
the "fixtures" service. Everything runs in a test jurisdiction "QZ" with
source keys "test-*", so the real TN pack in the same database is not touched.

Needs: FS_FIXTURES_BASE (http://fixtures:8081 in compose), a running TEI and
Ollama (real models in compose; mocks in the sandbox, see tests/mocks).
"""
import json
import os
import time
import uuid

import pytest

from conftest import assert_error, assert_ok, validate

FIX = os.environ.get("FS_FIXTURES_BASE", "http://fixtures:8081").rstrip("/")
SOURCES = [
    # key, path, type, reliability, language, fetch_config, cite_as
    ("test-law-fr", "/law_fr.html", "primary_law", 5, "fr", {"format": "html", "select": [{"tag": "div", "id": "content"}]}, "TST"),
    ("test-law-ar", "/law_ar.html", "primary_law", 5, "ar", {"format": "html"}, "TST"),
    ("test-guide-pdf", "/guide.pdf", "government_guide", 4, "fr", {"format": "pdf"}, None),
    ("test-private", "/private/secret.html", "blog", 1, "en", {}, None),
    ("test-blocked-ua", "/blocked-for-us.html", "blog", 1, "en", {}, None),
    ("test-empty", "/empty.html", "blog", 1, "en", {}, None),
    ("test-missing", "/does-not-exist.html", "blog", 1, "en", {}, None),
]
EXPECTED = {
    "test-law-fr": "ok", "test-law-ar": "ok", "test-guide-pdf": "ok",
    "test-private": "skipped", "test-blocked-ua": "skipped", "test-empty": "failed", "test-missing": "failed",
}
JOB_TIMEOUT_S = int(os.environ.get("FS_KB_JOB_TIMEOUT_S", "900"))


def make_user(db, role):
    return str(db.execute("insert into app.users (external_auth_id, role) values (%s, %s) returning id",
                          (f"test-{role}-{uuid.uuid4().hex[:10]}", role)).fetchone()[0])


@pytest.fixture(scope="module")
def zz(request):
    import psycopg
    with psycopg.connect(os.environ["FS_TEST_DB_DSN"], autocommit=True) as conn:
        conn.execute("""insert into app.jurisdictions (code, country_code, name, default_currency, default_locale, languages, timezone)
                        values ('QZ', 'QZ', 'Test jurisdiction (tests only)', 'TND', 'fr-TN', '{fr,ar}', 'Africa/Tunis')
                        on conflict do nothing""")
        conn.execute("delete from kb.sources where source_key like 'test-%'")
        for key, path, stype, rel, lang, fetch, cite in SOURCES:
            conn.execute("""insert into kb.sources (source_key, jurisdiction_code, title, url, publisher, source_type,
                                                    reliability, language, fetch_config, cite_as)
                            values (%s, 'QZ', %s, %s, 'test fixtures', %s, %s, %s, %s::jsonb, %s)""",
                         (key, key, FIX + path, stype, rel, lang, json.dumps(fetch), cite))
        admin = make_user(conn, "admin")
        user = make_user(conn, "user")
    return {"admin": admin, "user": user}


def wait_job(client, uid, status_url):
    deadline = time.time() + JOB_TIMEOUT_S
    while time.time() < deadline:
        r = client.call("GET", status_url, user_id=uid)
        j = assert_ok(r, 200, "JobResponse")
        if j["data"]["status"] in ("succeeded", "failed", "cancelled"):
            return j["data"]
        time.sleep(2)
    raise AssertionError(f"job {status_url} not finished after {JOB_TIMEOUT_S} s")


@pytest.fixture(scope="module")
def first_ingest(client, zz):
    r = client.call("POST", "/v1/admin/kb/ingest", body={"jurisdiction": "QZ", "include_global": False},
                    user_id=zz["admin"], idem="t-" + uuid.uuid4().hex)
    j = assert_ok(r, 202, "JobAcceptedResponse")
    assert j["data"]["status"] == "queued"
    assert j["data"]["status_url"] == f"/v1/jobs/{j['data']['job_id']}"
    return wait_job(client, zz["admin"], j["data"]["status_url"])


def by_key(job):
    return {s["source_key"]: s for s in job["output"]["sources"]}


# ------------------------------------------------------------------ access and validation
def test_ingest_requires_admin_role(client, zz, idem):
    assert_error(client.call("POST", "/v1/admin/kb/ingest", body={"jurisdiction": "QZ"}, user_id=zz["user"], idem=idem()),
                 403, "FORBIDDEN")
    assert_error(client.call("POST", "/v1/admin/kb/ingest", body={"jurisdiction": "QZ"}, idem=idem()), 401, "UNAUTHENTICATED")


def test_ingest_validation(client, zz, idem):
    j = assert_error(client.call("POST", "/v1/admin/kb/ingest", body={"jurisdiction": "tn", "force": "yes", "x": 1,
                                                                       "sources": ["Bad Key"]},
                                 user_id=zz["admin"], idem=idem()), 422, "VALIDATION_FAILED")
    fields = {d["field"] for d in j["error"]["details"]}
    assert {"jurisdiction", "force", "x", "sources[0]"} <= fields
    assert_error(client.call("POST", "/v1/admin/kb/ingest", body={"jurisdiction": "QZ"}, user_id=zz["admin"]),
                 422, "VALIDATION_FAILED")                                   # no idempotency key
    j = assert_error(client.call("POST", "/v1/admin/kb/ingest", body={"jurisdiction": "QQ"}, user_id=zz["admin"], idem=idem()),
                     422, "VALIDATION_FAILED")                               # well formed, unknown
    assert j["error"]["details"][0]["field"] == "jurisdiction"


# ------------------------------------------------------------------ ingestion
def test_ingest_outcomes_per_source(first_ingest):
    job = first_ingest
    assert job["status"] == "failed"                                         # two sources fail on purpose
    assert job["error"] == "2 of 7 sources failed"
    got = {k: v["status"] for k, v in by_key(job).items()}
    assert got == EXPECTED, got
    s = by_key(job)
    assert s["test-law-fr"]["action"] == "created"
    assert "extracted_too_short" in s["test-empty"]["error"]
    assert "fetch_http_404" in s["test-missing"]["error"]
    assert job["output"]["counts"] == {"ok": 3, "skipped": 2, "failed": 2}


def test_robots_rules_respected(first_ingest, db):
    rows = dict(db.execute("""select s.source_key, l.detail->'robots'->>'rule' from kb.ingest_log l
                              join kb.sources s on s.id = l.source_id
                              where s.source_key in ('test-private', 'test-blocked-ua') and l.step = 'robots'""").fetchall())
    assert rows == {"test-private": "disallow /private/", "test-blocked-ua": "disallow /blocked-for-us.html"}
    n = db.execute("""select count(*) from kb.raw_fetches r join kb.sources s on s.id = r.source_id
                      where s.source_key in ('test-private', 'test-blocked-ua')""").fetchone()[0]
    assert n == 0                                                            # never fetched


def test_documents_chunks_and_embeddings_stored(first_ingest, db):
    docs = db.execute("""select s.source_key, d.version, d.status, d.extractor, d.content, d.content_hash,
                                r.sha256, r.byte_count, d.char_count
                         from kb.documents d join kb.sources s on s.id = d.source_id
                         left join kb.raw_fetches r on r.id = d.raw_fetch_id
                         where s.source_key like 'test-%' order by 1""").fetchall()
    assert [d[0] for d in docs] == ["test-guide-pdf", "test-law-ar", "test-law-fr"]
    for key, ver, status, extractor, content, chash, rsha, nbytes, chars in docs:
        assert ver == 1 and status == "current"
        assert extractor == ("pdf_v1" if key.endswith("pdf") else "html_v1")
        assert len(chash) == 64 and len(rsha) == 64 and nbytes > 0 and chars == len(content)
    content = {d[0]: d[4] for d in docs}
    assert "يدفع المكتري معين الكراء" in content["test-law-ar"]             # decoded from windows-1256
    assert "Accueil" not in content["test-law-fr"] and "tracking" not in content["test-law-fr"]
    assert "GUIDE DE TEST" not in content["test-guide-pdf"]                 # running header removed
    assert "dans un delai de soixante jours" in content["test-guide-pdf"]    # wrapped line joined
    # every chunk is exactly its span of the document; B never crosses a heading
    bad = db.execute("""select count(*) from kb.chunks c join kb.documents d on d.id = c.document_id
                        where c.content <> substr(d.content, c.start_char + 1, c.end_char - c.start_char)""").fetchone()[0]
    assert bad == 0
    per = dict(db.execute("""select c.strategy, count(*) from kb.chunks c join kb.documents d on d.id = c.document_id
                             join kb.sources s on s.id = d.source_id where s.source_key like 'test-%' group by 1""").fetchall())
    assert set(per) == {"fixed_500_50", "structure_aware_v1"}
    emb = dict(db.execute("""select e.model, count(*) from kb.chunk_embeddings e join kb.chunks c on c.id = e.chunk_id
                             join kb.documents d on d.id = c.document_id join kb.sources s on s.id = d.source_id
                             where s.source_key like 'test-%' group by 1""").fetchall())
    total = sum(per.values())
    assert emb == {"bge-m3": total, "multilingual-e5-large": total}
    refs = [r[0] for r in db.execute("""select c.article_ref from kb.chunks c join kb.documents d on d.id = c.document_id
                                        join kb.sources s on s.id = d.source_id
                                        where s.source_key = 'test-law-fr' and c.strategy = 'structure_aware_v1'
                                        order by c.chunk_index""").fetchall()]
    assert refs == ["TST art. 1-12", "TST art. 13"]


def test_reingest_unchanged_is_skipped(client, zz, first_ingest, db, idem):
    before = db.execute("select array_agg(c.id order by c.id) from kb.chunks c join kb.documents d on d.id = c.document_id "
                        "join kb.sources s on s.id = d.source_id where s.source_key = 'test-law-fr'").fetchone()[0]
    r = client.call("POST", "/v1/admin/kb/ingest", body={"jurisdiction": "QZ", "include_global": False,
                                                          "sources": ["test-law-fr", "test-guide-pdf"]},
                    user_id=zz["admin"], idem=idem())
    job = wait_job(client, zz["admin"], assert_ok(r, 202)["data"]["status_url"])
    assert job["status"] == "succeeded"
    s = by_key(job)
    assert set(s) == {"test-law-fr", "test-guide-pdf"}
    assert all(v["status"] == "skipped" and v["step"] == "unchanged" for v in s.values()), s
    after = db.execute("select array_agg(c.id order by c.id) from kb.chunks c join kb.documents d on d.id = c.document_id "
                       "join kb.sources s on s.id = d.source_id where s.source_key = 'test-law-fr'").fetchone()[0]
    assert before == after
    raw = db.execute("select count(*) from kb.raw_fetches r join kb.sources s on s.id = r.source_id "
                     "where s.source_key = 'test-law-fr'").fetchone()[0]
    assert raw == 2                                                          # every fetch is kept


def test_force_creates_new_version_and_search_sees_only_current(client, zz, first_ingest, db, idem):
    r = client.call("POST", "/v1/admin/kb/ingest", body={"jurisdiction": "QZ", "include_global": False,
                                                          "sources": ["test-law-fr"], "force": True},
                    user_id=zz["admin"], idem=idem())
    job = wait_job(client, zz["admin"], assert_ok(r, 202)["data"]["status_url"])
    assert by_key(job)["test-law-fr"]["action"] == "updated"
    versions = db.execute("""select d.version, d.status from kb.documents d join kb.sources s on s.id = d.source_id
                             where s.source_key = 'test-law-fr' order by 1""").fetchall()
    assert versions == [(1, "superseded"), (2, "current")]
    hits = db.execute("""select distinct d.version from kb.search_chunks('bge-m3', 'structure_aware_v1', null,
                           'dépôt garantie restitué', 'QZ', 1::smallint, 20, 'lexical') r
                         join kb.documents d on d.id = r.document_id""").fetchall()
    assert hits == [(2,)]


def test_retried_request_returns_the_same_job(client, zz, idem):
    key = idem()
    body = {"jurisdiction": "QZ", "include_global": False, "sources": ["test-law-ar"]}
    a = assert_ok(client.call("POST", "/v1/admin/kb/ingest", body=body, user_id=zz["admin"], idem=key), 202)
    b = client.call("POST", "/v1/admin/kb/ingest", body=body, user_id=zz["admin"], idem=key)
    assert b.status_code == 202 and b.json()["data"]["job_id"] == a["data"]["job_id"]
    wait_job(client, zz["admin"], a["data"]["status_url"])


# ------------------------------------------------------------------ job status
def test_parameterised_routes_reach_their_workflows(client, zz):
    """Both routes with a path parameter must be answered by n8n, not by the proxy's 404."""
    for path, msg in ((f"/v1/jobs/{uuid.uuid4()}", "Job not found"),
                      (f"/v1/admin/eval/runs/{uuid.uuid4()}", "Evaluation run not found")):
        j = assert_error(client.call("GET", path, user_id=zz["admin"]), 404, "NOT_FOUND")
        assert j["error"]["message"] == msg, (path, j)


def test_job_status_visibility(client, zz, first_ingest, db):
    jid = first_ingest["job_id"]
    other = make_user(db, "user")
    assert_error(client.call("GET", f"/v1/jobs/{jid}", user_id=other), 404, "NOT_FOUND")
    assert_error(client.call("GET", "/v1/jobs/not-a-uuid", user_id=zz["admin"]), 404, "NOT_FOUND")
    j = assert_error(client.call("GET", f"/v1/jobs/{uuid.uuid4()}", user_id=zz["admin"]), 404, "NOT_FOUND")
    assert j["error"]["message"] == "Job not found"            # answered by the workflow, not by the proxy (F-026)
    assert_error(client.call("GET", f"/v1/jobs/{jid}"), 401, "UNAUTHENTICATED")
    moderator = make_user(db, "moderator")
    assert_ok(client.call("GET", f"/v1/jobs/{jid}", user_id=moderator), 200, "JobResponse")


# ------------------------------------------------------------------ evaluation
def make_dataset(db, name, queries):
    ds = db.execute("insert into eval.datasets (name, kind, version) values (%s, 'retrieval', 1) "
                    "on conflict (name, version) do update set notes = null returning id", (name,)).fetchone()[0]
    db.execute("delete from eval.runs where dataset_id = %s", (ds,))
    db.execute("delete from eval.queries where dataset_id = %s", (ds,))
    for qid, q, lang, gold, tags in queries:
        db.execute("""insert into eval.queries (dataset_id, external_id, query, language, jurisdiction_code, gold, tags)
                      values (%s, %s, %s, %s, 'QZ', %s::jsonb, %s)""", (ds, qid, q, lang, json.dumps(gold), tags))
    return ds


GOLD_DEPOT = {"spans": [{"source_key": "test-law-fr", "start": "Le dépôt de garantie de test", "end": "fin du bail fictif."}]}
GOLD_FEE = {"spans": [{"source_key": "test-guide-pdf", "start": "Le droit fixe fictif", "end": "document de test."}]}


def test_eval_run_end_to_end(client, zz, first_ingest, db, idem):
    make_dataset(db, "test_retrieval", [
        ("q1", "dépôt de garantie restitué fin du bail", "fr", GOLD_DEPOT, []),
        ("q2", "droit fixe dinars par page", "fr", GOLD_FEE, []),
        ("q3", "deposit returned at the end of the lease", "en", GOLD_DEPOT, ["cross_lingual"]),
        ("q4", "quelle est la météo demain", "fr", {"spans": []}, ["abstain"]),
    ])
    configs = [{"strategy": s, "model": "bge-m3", "mode": m} for s in ("fixed_500_50", "structure_aware_v1")
               for m in ("lexical", "hybrid")] + [{"strategy": "structure_aware_v1", "model": "multilingual-e5-large", "mode": "dense"}]
    r = client.call("POST", "/v1/admin/eval/runs", body={"dataset": "test_retrieval", "jurisdiction": "QZ", "k": 5,
                                                          "configs": configs, "git_sha": "test"},
                    user_id=zz["admin"], idem=idem())
    job = wait_job(client, zz["admin"], assert_ok(r, 202, "JobAcceptedResponse")["data"]["status_url"])
    assert job["status"] == "succeeded", job
    runs = job["output"]["runs"]
    assert len(runs) == 5
    for run in runs:
        s = run["summary"]
        assert s["queries"] == 4 and s["scored"] == 3                       # the abstain query has no gold
        assert s["latency_ms_p95"] is not None
    lex_b = next(x for x in runs if x["config"]["strategy"] == "structure_aware_v1" and x["config"]["mode"] == "lexical")
    detail = assert_ok(client.call("GET", f"/v1/admin/eval/runs/{lex_b['run_id']}", user_id=zz["admin"]), 200, "EvalRunResponse")
    per = {q["query_id"]: q["metrics"] for q in detail["data"]["queries"]}
    assert per["q1"]["hit@1"] == 1                                          # article 13 is its own B chunk
    assert per["q2"]["hit@1"] == 1
    assert per["q4"]["gold_spans"] == 0 and per["q4"]["mrr"] is None
    stored = db.execute("select count(*) from eval.results where run_id = %s", (lex_b["run_id"],)).fetchone()[0]
    assert stored == 4
    assert_error(client.call("GET", f"/v1/admin/eval/runs/{lex_b['run_id']}", user_id=zz["user"]), 403, "FORBIDDEN")
    j = assert_error(client.call("GET", f"/v1/admin/eval/runs/{uuid.uuid4()}", user_id=zz["admin"]), 404, "NOT_FOUND")
    assert j["error"]["message"] == "Evaluation run not found"


def test_eval_with_unresolvable_gold_fails_the_job(client, zz, first_ingest, db, idem):
    make_dataset(db, "test_retrieval_broken", [
        ("b1", "dépôt", "fr", {"spans": [{"source_key": "test-law-fr", "start": "text that is not there", "end": "."}]}, []),
    ])
    r = client.call("POST", "/v1/admin/eval/runs", body={"dataset": "test_retrieval_broken", "jurisdiction": "QZ",
                                                          "configs": [{"strategy": "fixed_500_50", "model": "bge-m3", "mode": "lexical"}]},
                    user_id=zz["admin"], idem=idem())
    job = wait_job(client, zz["admin"], assert_ok(r, 202)["data"]["status_url"])
    assert job["status"] == "failed"
    n = db.execute("select count(*) from eval.runs r join eval.datasets d on d.id = r.dataset_id "
                   "where d.name = 'test_retrieval_broken'").fetchone()[0]
    assert n == 0                                                           # no partial numbers


def test_eval_validation(client, zz, idem):
    j = assert_error(client.call("POST", "/v1/admin/eval/runs",
                                 body={"dataset": "x", "jurisdiction": "QZ", "k": 0,
                                       "configs": [{"strategy": "fixed_500_50", "model": "gpt", "mode": "fuzzy", "extra": 1}]},
                                 user_id=zz["admin"], idem=idem()), 422, "VALIDATION_FAILED")
    fields = {d["field"] for d in j["error"]["details"]}
    assert {"dataset", "k", "configs[0].model", "configs[0].mode", "configs[0].extra"} <= fields
