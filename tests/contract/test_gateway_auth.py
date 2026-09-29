"""Signature, timestamp, replay and rate-limit behaviour, through GET /v1/health
(the cheapest signed route) and POST /v1/users/sync (a state-changing route)."""
import time
import uuid

import httpx
import pytest

from conftest import assert_error, assert_ok


def test_signed_request_accepted(client):
    rid = str(uuid.uuid4())
    r = client.call("GET", "/v1/health", request_id=rid)
    # 200 when every dependency is up, 503 when one is down: both prove the signature was accepted.
    assert r.status_code in (200, 503), r.text
    j = r.json()
    assert j["request_id"] == rid
    assert "checks" in j.get("data", {}) or j["error"]["code"] == "UPSTREAM_UNAVAILABLE"


def test_unsigned_request_rejected(base, client):
    r = httpx.get(base + "/v1/health", timeout=10)
    j = assert_error(r, 401, "UNAUTHENTICATED")
    uuid.UUID(j["request_id"])  # server generated a correlation id


def test_missing_single_header_rejected(client):
    for drop in ("X-Signature", "X-Timestamp", "X-Key-Id", "X-Request-Id"):
        url, h, b = client.build("GET", "/v1/health")
        del h[drop]
        assert_error(client.send("GET", url, h, b), 401, "UNAUTHENTICATED")


def test_wrong_signature_rejected(client):
    url, h, b = client.build("GET", "/v1/health")
    h["X-Signature"] = ("0" if h["X-Signature"][0] != "0" else "1") + h["X-Signature"][1:]
    assert_error(client.send("GET", url, h, b), 401, "UNAUTHENTICATED")


def test_signature_from_other_secret_rejected(client):
    from fsclient import Client
    other = Client(client.base_url, client.key_id, "fss_" + "ab" * 32)
    assert_error(other.call("GET", "/v1/health"), 401, "UNAUTHENTICATED")


def test_unknown_key_rejected(client):
    url, h, b = client.build("GET", "/v1/health")
    h["X-Key-Id"] = "nobody"
    assert_error(client.send("GET", url, h, b), 401, "UNAUTHENTICATED")


def test_old_timestamp_rejected_with_server_time(client):
    r = client.call("GET", "/v1/health", ts=int(time.time()) - 305)
    j = assert_error(r, 401, "UNAUTHENTICATED")
    assert "server_time" in j["error"]["details"][0]


def test_future_timestamp_rejected(client):
    assert_error(client.call("GET", "/v1/health", ts=int(time.time()) + 305), 401, "UNAUTHENTICATED")


def test_replayed_request_rejected(client):
    url, h, b = client.build("GET", "/v1/health")
    first = client.send("GET", url, h, b)
    assert first.status_code in (200, 503)
    assert_error(client.send("GET", url, h, b), 401, "UNAUTHENTICATED")


def test_tampered_query_rejected(client):
    url, h, b = client.build("GET", "/v1/health", params={"a": "1"})
    assert_error(client.send("GET", url.replace("a=1", "a=2"), h, b), 401, "UNAUTHENTICATED")


def test_repeated_and_encoded_query_params_accepted(client):
    # canonical query: encoded keys sorted, repeated keys keep order, reserved characters encoded
    r = client.call("GET", "/v1/health", params=[("z", "1"), ("a", "x y&z=é"), ("a", "2")])
    assert r.status_code in (200, 503), r.text


def test_nested_query_rejected(client):
    url, h, b = client.build("GET", "/v1/health")
    r = client.send("GET", url + "?a[b]=1", h, b)
    assert_error(r, 422, "VALIDATION_FAILED")


def test_tampered_body_rejected(client, idem):
    url, h, b = client.build("POST", "/v1/users/sync", body={"external_auth_id": "auth|tamper"}, idem=idem())
    assert_error(client.send("POST", url, h, b.replace(b"tamper", b"tamperX")), 401, "UNAUTHENTICATED")


def test_body_whitespace_is_signed_bytes(client, idem):
    # same JSON value, different bytes: the signature covers the raw bytes
    url, h, b = client.build("POST", "/v1/users/sync", body={"external_auth_id": "auth|ws"}, idem=idem())
    assert_error(client.send("POST", url, h, b.replace(b": ", b":  ")), 401, "UNAUTHENTICATED")


def test_swapped_user_id_rejected(client, idem):
    url, h, b = client.build("POST", "/v1/users/sync", body={"external_auth_id": "auth|swap"}, idem=idem(),
                             user_id="00000000-0000-0000-0000-00000000000a")
    h["X-User-Id"] = "00000000-0000-0000-0000-00000000000b"
    assert_error(client.send("POST", url, h, b), 401, "UNAUTHENTICATED")


def test_swapped_idempotency_key_rejected(client, idem):
    url, h, b = client.build("POST", "/v1/users/sync", body={"external_auth_id": "auth|idemswap"}, idem=idem())
    h["X-Idempotency-Key"] = idem()
    assert_error(client.send("POST", url, h, b), 401, "UNAUTHENTICATED")


def test_signature_for_other_route_rejected(client, idem):
    # a request signed for /v1/users/sync replayed against another route
    url, h, b = client.build("POST", "/v1/users/sync", body={"external_auth_id": "auth|route"}, idem=idem())
    assert_error(client.send("GET", url.replace("/v1/users/sync", "/v1/health"), h, b), 401, "UNAUTHENTICATED")


def test_rate_limit_per_ip(client, db):
    ip = f"203.0.113.{uuid.uuid4().int % 250}"
    with db.cursor() as cur:
        cur.execute("update app.settings set value = '5' where key = 'gateway.rate_limit_ip_per_min'")
    try:
        # wait for a fresh minute window if we are close to the boundary
        if time.time() % 60 > 50:
            time.sleep(61 - time.time() % 60)
        codes = []
        last = None
        for _ in range(7):
            last = client.call("GET", "/v1/health", client_ip=ip)
            codes.append(last.status_code)
        assert codes[:5].count(429) == 0, codes
        assert codes[5:] == [429, 429], codes
        j = assert_error(last, 429, "RATE_LIMITED")
        assert int(last.headers["retry-after"]) >= 1
        assert j["error"]["details"][0]["retry_after_s"] >= 1
    finally:
        with db.cursor() as cur:
            cur.execute("update app.settings set value = '120' where key = 'gateway.rate_limit_ip_per_min'")


def test_rate_limit_counts_bad_signatures(client, db):
    """Failed signatures count against the network IP, and a spoofed X-Client-Ip
    on an unsigned request does not move the request to another bucket."""
    import os
    net_ip = f"198.51.100.{uuid.uuid4().int % 250}"
    with db.cursor() as cur:
        cur.execute("update app.settings set value = '3' where key = 'gateway.rate_limit_ip_per_min'")
    try:
        if os.environ.get("FS_VIA_PROXY") == "1":
            time.sleep(61 - time.time() % 60)   # proxy sets X-Forwarded-For itself: start a fresh window
        elif time.time() % 60 > 50:
            time.sleep(61 - time.time() % 60)
        codes = []
        for i in range(5):
            url, h, b = client.build("GET", "/v1/health", client_ip=f"192.0.2.{i}")
            h["X-Signature"] = "0" * 64
            h["X-Forwarded-For"] = net_ip
            codes.append(client.send("GET", url, h, b).status_code)
        assert codes == [401, 401, 401, 429, 429], codes
    finally:
        with db.cursor() as cur:
            cur.execute("update app.settings set value = '120' where key = 'gateway.rate_limit_ip_per_min'")
