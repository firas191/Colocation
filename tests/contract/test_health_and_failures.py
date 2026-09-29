"""GET /v1/health, dependency outages, malformed input, unexpected workflow errors.

Outage tests stop and restart a dependency with shell commands given in the
environment, so the same tests run in the sandbox and against docker compose:
  FS_OUTAGE_<NAME>_STOP / FS_OUTAGE_<NAME>_START   NAME in DATABASE, APPDB, OLLAMA, STORAGE
  (APPDB: lock the n8n_worker role and end its sessions, so only the
   application database connection fails while n8n itself keeps running)
Tests whose commands are not set are skipped (and reported as skipped).
"""
import os
import subprocess
import time
import uuid

import httpx
import pytest

from conftest import assert_error, assert_ok, direct_only, proxy_only, validate


def outage(name):
    stop, start = os.environ.get(f"FS_OUTAGE_{name}_STOP"), os.environ.get(f"FS_OUTAGE_{name}_START")
    if not (stop and start):
        pytest.skip(f"FS_OUTAGE_{name}_STOP/START not set")
    return stop, start


def run(cmd):
    subprocess.run(cmd, shell=True, check=True, capture_output=True, timeout=120)


def test_health_all_up(client):
    j = assert_ok(client.call("GET", "/v1/health"), 200, "HealthResponse")
    d = j["data"]
    assert d["status"] == "ok"
    assert d["checks"]["database"]["ok"] and d["checks"]["database"]["migration"] >= "0006"
    assert set(d["checks"]["database"]["extensions"]) >= {"vector", "postgis", "pg_trgm", "pgcrypto"}
    assert d["checks"]["object_storage"]["ok"]
    assert d["checks"]["ollama"]["ok"] and d["checks"]["ollama"]["embed_model_present"]


def test_health_reports_missing_embedding_model(client, db):
    with db.cursor() as cur:
        cur.execute("select value from app.settings where key = 'ollama.embed_model'")
        old = cur.fetchone()[0]
        cur.execute("update app.settings set value = '\"no-such-model\"' where key = 'ollama.embed_model'")
    try:
        r = client.call("GET", "/v1/health")
        assert r.status_code == 503, r.text
        validate(r.json(), "HealthResponse")
        o = r.json()["data"]["checks"]["ollama"]
        assert o["reachable"] is True and o["embed_model_present"] is False and o["ok"] is False
        assert r.json()["data"]["status"] == "degraded"
    finally:
        with db.cursor() as cur:
            cur.execute("update app.settings set value = %s where key = 'ollama.embed_model'", (psycopg_json(old),))


def psycopg_json(v):
    import json
    return json.dumps(v)


@pytest.mark.parametrize("name,check", [("OLLAMA", "ollama"), ("STORAGE", "object_storage")])
def test_health_when_dependency_down(client, name, check):
    stop, start = outage(name)
    run(stop)
    try:
        t = time.time()
        r = client.call("GET", "/v1/health")
        elapsed = time.time() - t
        assert r.status_code == 503, r.text
        assert r.json()["data"]["checks"][check]["ok"] is False
        assert elapsed < 10, f"health took {elapsed:.1f}s with {name} down"
    finally:
        run(start)
        time.sleep(2)
    assert client.call("GET", "/v1/health").status_code == 200


def test_database_server_down(client, idem):
    """The whole PostgreSQL server is down. n8n keeps its own data in the same
    server, so n8n itself answers 503 before any workflow runs. Through the
    proxy that answer is turned into the standard envelope."""
    stop, start = outage("DATABASE")
    run(stop)
    try:
        for method, path, kw in (("GET", "/v1/health", {}),
                                 ("POST", "/v1/users/sync", {"body": {"external_auth_id": "auth|dbdown"}, "idem": idem()})):
            t = time.time()
            r = client.call(method, path, **kw)
            elapsed = time.time() - t
            assert r.status_code == 503, (path, r.status_code, r.text)
            assert "stack" not in r.text.lower()
            if os.environ.get("FS_VIA_PROXY") == "1":
                assert_error(r, 503, "UPSTREAM_UNAVAILABLE")
            assert elapsed < 15, f"{path} took {elapsed:.1f}s with the database down"
    finally:
        run(start)
        _wait_healthy(client)


def test_app_database_unreachable_gives_503_envelope(client, idem):
    """n8n is fine but its connection to the application database fails
    (role locked and sessions killed): the workflows answer with the envelope."""
    stop, start = outage("APPDB")
    run(stop)
    try:
        for method, path, kw in (("GET", "/v1/health", {}),
                                 ("POST", "/v1/users/sync", {"body": {"external_auth_id": "auth|appdb"}, "idem": idem()})):
            t = time.time()
            r = client.call(method, path, **kw)
            elapsed = time.time() - t
            assert_error(r, 503, "UPSTREAM_UNAVAILABLE")
            assert elapsed < 15, f"{path} took {elapsed:.1f}s"
    finally:
        run(start)
        _wait_healthy(client)


def _wait_healthy(client):
    for _ in range(60):
        try:
            if client.call("GET", "/v1/health").status_code == 200:
                return
        except httpx.HTTPError:
            pass
        time.sleep(1)
    raise AssertionError("stack did not recover within 60 s")


def test_malformed_json_body(client, idem):
    """A signed body that is not valid JSON must not produce a 2xx or a stack trace."""
    url, h, b = client.build("POST", "/v1/users/sync", raw_body=b'{"external_auth_id": "x",', idem=idem())
    r = client.send("POST", url, h, b)
    assert 400 <= r.status_code < 500, (r.status_code, r.text)
    assert "stack" not in r.text.lower()
    if os.environ.get("FS_VIA_PROXY") == "1":
        # n8n rejects the body before any workflow runs; the proxy adds the envelope
        assert_error(r, 422, "VALIDATION_FAILED")


def test_empty_body_on_post(client, idem):
    url, h, b = client.build("POST", "/v1/users/sync", raw_body=b"", idem=idem(), headers={"Content-Type": "application/json"})
    r = client.send("POST", url, h, b)
    assert_error(r, 422, "VALIDATION_FAILED")


def _wait_failed_execution(db, workflow, since):
    for _ in range(30):
        with db.cursor() as cur:
            cur.execute("select error from ai.executions where workflow = %s and status = 'failed' and started_at >= %s "
                        "order by started_at desc limit 1", (workflow, since))
            row = cur.fetchone()
        if row:
            return row[0]
        time.sleep(1)
    return None


@direct_only
def test_unexpected_error_recorded_by_error_handler_direct(base, db):
    """Without the proxy n8n answers an unexpected failure with its own body;
    the error workflow must still record it."""
    with db.cursor() as cur:
        cur.execute("select now()")
        since = cur.fetchone()[0]
    r = httpx.get(base + "/v1/test/fail", timeout=30)
    assert r.status_code >= 500
    assert "stack" not in r.text.lower()
    err = _wait_failed_execution(db, "wf.test.fail", since)
    assert err and "deliberate failure" in err


@proxy_only
def test_unexpected_error_enveloped_by_proxy(base, db):
    with db.cursor() as cur:
        cur.execute("select now()")
        since = cur.fetchone()[0]
    r = httpx.get(base + "/v1/test/fail", timeout=30)
    j = r.json()
    assert r.status_code == 500 and j["error"]["code"] == "INTERNAL"
    assert _wait_failed_execution(db, "wf.test.fail", since)


@proxy_only
def test_unknown_route_enveloped_by_proxy(base):
    r = httpx.post(base + "/v1/does-not-exist", json={}, timeout=10)
    assert r.status_code == 404 and r.json()["error"]["code"] == "NOT_FOUND"
    assert "webhook" not in r.text.lower()


@proxy_only
def test_n8n_internals_not_reachable_through_proxy(base):
    for path in ("/rest/settings", "/webhook-test/v1/health", "/webhook/v1/health", "/healthz", "/"):
        r = httpx.get(base + path, timeout=10)
        assert r.status_code == 404, (path, r.status_code)


@proxy_only
def test_oversized_body_rejected_by_proxy(client, idem):
    big = {"external_auth_id": "x" * (2 * 1024 * 1024)}
    r = client.call("POST", "/v1/users/sync", body=big, idem=idem())
    assert_error(r, 413, "PAYLOAD_TOO_LARGE")
