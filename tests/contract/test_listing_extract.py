"""Phase 4.4 contract tests: the listing text extraction (P3) inside the analyze job, and P3 golden-set runs.

In the sandbox the model is the mock of tests/mocks/deps_mock.py (keyword rules, markers for failure paths),
so these tests check the plumbing and the deterministic checks, not extraction quality. On the PC the real
model answers; the tests that depend on the mock's answers are sandbox-only.
"""
import uuid

import pytest

from conftest import assert_error, assert_ok, sandbox_only
from test_intake_media import create, owner  # noqa: F401  (module fixture reused)
from test_profile_search import make_user, wait_job


def analyze(client, uid, idem, text):
    lid = create(client, uid, idem, text=text).json()["data"]["listing_id"]
    r = client.call("POST", f"/v1/listings/{lid}/analyze", body={}, user_id=uid, idem=idem())
    job = wait_job(client, uid, assert_ok(r, 202, "JobAcceptedResponse")["data"]["status_url"])
    return lid, job


def view(client, uid, lid):
    return assert_ok(client.call("GET", f"/v1/listings/{lid}", user_id=uid), 200, "ListingResponse")["data"]


def test_text_only_listing_can_be_analyzed(client, owner, idem):  # noqa: F811
    lid, job = analyze(client, owner["owner"], idem, "Chambre à Testville, 400 DT")
    assert job["status"] in ("succeeded", "failed"), job
    assert job["output"]["extraction"]["status"] in ("extracted", "failed")
    assert job["output"]["processed"] == 0


@sandbox_only
def test_extraction_stored_with_minor_units_and_trace(client, owner, idem, db):  # noqa: F811
    lid, job = analyze(client, owner["owner"], idem,
                       "Chambre meublée dans un S+2 à Testville, 450.000 DT CC, wifi, non fumeur. Contact: 22 345 678")
    assert job["status"] == "succeeded", job
    v = view(client, owner["owner"], lid)
    assert (v["rent_minor"], v["currency"], v["rent_period"], v["rent_scope"]) == (450000, "TND", "month", "per_room")
    assert v["bedrooms"] == 2 and v["furnished"] is True and v["bills_included"] is True
    assert v["amenities"] == ["wifi"] and v["house_rules"] == {"smoking": "no"}
    ex = v["extraction"]
    assert ex["model_output"]["rent_amount"] == 450                         # the model answers in main units (D-066)
    assert "contact_details_in_text" in ex["issues"] and ex["pii_counts"]["PHONE"] == 1
    assert "22 345 678" not in str(ex)                                        # counts only, never the number
    assert job["output"]["extraction"] == {"status": "extracted", "issues": ex["issues"], "rent_scope": "per_room", "error": None}
    row = db.execute("""select s.agent, s.prompt_version_id is not null, e.channel, e.status, s.input::text
                        from ai.executions e join ai.agent_steps s on s.execution_id = e.id
                        where e.request_id = %s and e.workflow = 'wf.listing.extract'""", (job["job_id"],)).fetchone()
    assert row[:4] == ("A1_extract", True, "job", "succeeded") and "Testville" not in row[4]


@sandbox_only
def test_scale_error_is_caught_by_the_range_check(client, owner, idem):  # noqa: F811
    lid, job = analyze(client, owner["owner"], idem, "Chambre à Testville, 450 DT par mois [mock:scale]")
    assert job["status"] == "succeeded", job
    v = view(client, owner["owner"], lid)
    assert v["extraction"]["model_output"]["rent_amount"] == 450000          # what the model said
    assert v["rent_minor"] is None and v["currency"] is None and v["rent_scope"] is None
    assert {"rent_out_of_range", "rent_missing"} <= set(v["extraction"]["issues"])


@sandbox_only
def test_invalid_answer_fails_the_job_without_retry(client, owner, idem, db):  # noqa: F811
    lid, job = analyze(client, owner["owner"], idem, "Chambre à Testville, 450 DT [mock:invalid]")
    assert job["status"] == "failed" and "extraction failed" in job["error"], job
    row = db.execute("select attempts, next_attempt_at from app.jobs where id = %s", (job["job_id"],)).fetchone()
    assert row == (1, None)
    assert view(client, owner["owner"], lid)["extraction"] == {}


@sandbox_only
def test_model_down_job_is_retried(client, owner, idem, db):  # noqa: F811
    lid = create(client, owner["owner"], idem, text="Chambre à Testville, 450 DT [mock:down]").json()["data"]["listing_id"]
    r = client.call("POST", f"/v1/listings/{lid}/analyze", body={}, user_id=owner["owner"], idem=idem())
    jid = assert_ok(r, 202, "JobAcceptedResponse")["data"]["job_id"]
    import time
    for _ in range(60):
        row = db.execute("select status, attempts, next_attempt_at, last_error from app.jobs where id = %s", (jid,)).fetchone()
        if row[0] != "running" and row[1] == 1:
            break
        time.sleep(1)
    assert row[0] == "queued" and row[2] is not None and "model unavailable" in row[3], row


# ------------------------------------------------------------------ golden-set runs
def _conn():
    import os
    import psycopg
    return psycopg.connect(os.environ["FS_TEST_DB_DSN"], autocommit=True)


@pytest.fixture(scope="module")
def p3_dataset():
    import json
    db = _conn()
    ds = db.execute("""insert into eval.datasets (name, kind, version) values ('test_p3', 'extraction', 1)
                       on conflict (name, version) do update set kind = excluded.kind returning id""").fetchone()[0]
    db.execute("delete from eval.queries where dataset_id = %s", (ds,))
    base = {"kind": "room", "rent_amount": None, "rent_currency": None, "rent_period": None, "rent_scope": None,
            "deposit_amount": None, "deposit_currency": None, "bills_included": None, "available_from": None, "bedrooms": None,
            "furnished": None, "amenities": [], "house_rules": {}, "address_text": None, "city": None, "neighbourhood": None}
    items = [("l1", "Chambre meublée S+2, 450.000 DT, wifi", {**base, "rent_amount": 450, "rent_currency": "TND", "rent_period": "month",
                                                              "rent_scope": "per_room", "bedrooms": 2, "furnished": True, "amenities": ["wifi"]}, ["fr", "unit_trap"]),
             ("l2", "Chambre 450 DT [mock:scale]", {**base, "rent_amount": 450, "rent_currency": "TND", "rent_period": "month",
                                                   "rent_scope": "per_room"}, ["fr", "unit_trap"]),
             ("l3", "Chambre 450 DT [mock:long]", {**base, "rent_amount": 450, "rent_currency": "TND", "rent_period": "month",
                                                  "rent_scope": "per_room"}, ["fr"])]
    for ext, msg, gold, tags in items:
        db.execute("insert into eval.queries (dataset_id, external_id, query, language, jurisdiction_code, gold, tags) "
                   "values (%s, %s, %s, 'fr', 'QX', %s::jsonb, %s)",
                   (ds, ext, msg, json.dumps({"labels": gold, "context": {"jurisdiction": "QX", "today": "2026-10-01"}}), tags))
    db.close()
    return ds


@pytest.fixture(scope="module")
def admin(owner):  # noqa: F811  (owner creates the QX jurisdiction)
    db = _conn()
    uid = make_user(db, "admin")
    db.close()
    return uid


def test_p3_eval_validation(client, admin, idem):
    j = assert_error(client.call("POST", "/v1/admin/eval/prompt-runs", body={"prompt": "P3_listing", "versions": [1]},
                                 user_id=admin, idem=idem()), 422, "VALIDATION_FAILED")
    assert j["error"]["details"][0]["field"] == "prompt"


@sandbox_only
def test_p3_eval_scores_model_answer_and_checked_answer(client, p3_dataset, admin, db):
    r = client.call("POST", "/v1/admin/eval/prompt-runs", body={"prompt": "P3_listing_extractor", "versions": [1, 2],
                    "models": ["qwen3.5:4b"], "dataset": "test_p3", "item_ids": ["l1", "l2"]}, user_id=admin, idem="t-" + uuid.uuid4().hex)
    job = wait_job(client, admin, assert_ok(r, 202, "JobAcceptedResponse")["data"]["status_url"])
    assert job["status"] == "succeeded", job
    for run in job["output"]["runs"]:
        s = db.execute("select summary from eval.runs where id = %s", (run["run_id"],)).fetchone()[0]
        assert s["items"] == 2 and s["json_valid"] == 1
        assert s["unit_error_items"] == 1 and s["unit_error_items_checked"] == 0 and s["range_check_nulled_items"] == 1
        assert s["checked"]["f1"] < s["f1"] or s["checked"]["recall"] < 1           # the nulled rent is now missed
        assert run["unit_error_items"] == 1 and run["unit_error_items_checked"] == 0
    o = db.execute("""select x.output from eval.results x join eval.queries q on q.id = x.query_id
                      where x.run_id = %s and q.external_id = 'l2'""", (job["output"]["runs"][0]["run_id"],)).fetchone()[0]
    assert o["output"]["rent_amount"] == 450000 and o["checked"]["rent_amount"] is None


@sandbox_only
def test_answer_cut_at_the_token_limit_is_reported_as_truncated(client, p3_dataset, admin, db):
    """F-058: an answer that hits num_predict (Ollama done_reason 'length') is counted as truncated, not as plain bad JSON."""
    r = client.call("POST", "/v1/admin/eval/prompt-runs", body={"prompt": "P3_listing_extractor", "versions": [3, 4],
                    "models": ["qwen3.5:4b"], "dataset": "test_p3", "item_ids": ["l3"]}, user_id=admin, idem="t-" + uuid.uuid4().hex)
    job = wait_job(client, admin, assert_ok(r, 202, "JobAcceptedResponse")["data"]["status_url"])
    assert job["status"] == "succeeded", job
    for run in job["output"]["runs"]:
        s = db.execute("select summary from eval.runs where id = %s", (run["run_id"],)).fetchone()[0]
        assert s["items"] == 1 and s["json_valid"] == 0 and s["truncated_items"] == 1 and s["retried_items"] == 1, s
        o = db.execute("select output from eval.results where run_id = %s", (run["run_id"],)).fetchone()[0]
        assert o["error_code"] == "truncated" and "output limit" in o["detail"] and o["first_error"]["error_code"] == "truncated"


@sandbox_only
def test_dispatcher_starts_every_due_job(client, owner, idem, db):  # noqa: F811
    """F-054: two jobs due in the same minute both run (the worker handles one job per execution)."""
    import json
    import time
    ids = []
    for i in range(2):
        lid = create(client, owner["owner"], idem, text=f"Chambre à Testville, {400 + i} DT").json()["data"]["listing_id"]
        ids.append(str(db.execute("""insert into app.jobs (type, input, status, next_attempt_at, requested_by)
                                     values ('listing_analyze', %s::jsonb, 'queued', now(), %s) returning id""",
                                  (json.dumps({"listing_id": lid, "user_id": owner["owner"]}), owner["owner"])).fetchone()[0]))
    deadline = time.time() + 150                      # wf.jobs.dispatch runs every minute
    while time.time() < deadline:
        rows = db.execute("select status from app.jobs where id = any(%s::uuid[])", (ids,)).fetchall()
        if all(r[0] in ("succeeded", "failed") for r in rows):
            break
        time.sleep(3)
    assert sorted(r[0] for r in rows) == ["succeeded", "succeeded"], rows
