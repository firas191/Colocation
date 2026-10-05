"""POST /v1/me/consents and GET /v1/admin/traces/:request_id (spec 6.2; added for the Telegram channel, D-079)."""
import os
import uuid

import psycopg
import pytest

from conftest import assert_error, assert_ok
from test_profile_search import make_user


@pytest.fixture(scope="module")
def users():
    db = psycopg.connect(os.environ["FS_TEST_DB_DSN"], autocommit=True)
    db.execute("""insert into app.jurisdictions (code, country_code, name, default_currency, default_locale, languages, timezone)
                  values ('QX', 'QX', 'Test jurisdiction (tests only)', 'TND', 'fr-TN', '{fr,ar}', 'Africa/Tunis') on conflict do nothing""")
    u = {"plain": make_user(db, "user", ()), "admin": make_user(db, "admin"), "user": make_user(db, "user")}
    db.execute("delete from app.rate_counters where bucket like 'ip:%'")
    db.close()
    return u


def test_consents_recorded_without_prior_consent(client, users, idem):
    uid = users["plain"]
    body = {"consents": [{"purpose": "terms", "granted": True}, {"purpose": "privacy", "granted": True}], "policy_version": "v-test",
            "source": "api"}
    d = assert_ok(client.call("POST", "/v1/me/consents", body=body, user_id=uid, idem=idem()), 200)["data"]
    assert d["consents"]["terms"]["granted"] is True and d["consent_required"] == []
    d = assert_ok(client.call("POST", "/v1/me/consents", body={"consents": [{"purpose": "privacy", "granted": False}],
                                                               "policy_version": "v-test"}, user_id=uid, idem=idem()), 200)["data"]
    assert d["consent_required"] == ["privacy"]


def test_consents_validation(client, users, idem):
    uid = users["plain"]
    bad = {"consents": [{"purpose": "spam", "granted": "yes"}, {"purpose": "spam", "granted": True}], "policy_version": "", "x": 1}
    j = assert_error(client.call("POST", "/v1/me/consents", body=bad, user_id=uid, idem=idem()), 422, "VALIDATION_FAILED")
    fields = {d["field"] for d in j["error"]["details"]}
    assert {"x", "policy_version", "consents"} <= fields
    assert_error(client.call("POST", "/v1/me/consents", body={"consents": [{"purpose": "terms", "granted": True}],
                                                               "policy_version": "v"}, idem=idem()), 401, "UNAUTHENTICATED")


def test_trace_is_for_admins_and_shows_the_steps(client, users, db):
    r = client.call("GET", "/v1/health")
    rid = r.headers["X-Request-Id"]
    assert_error(client.call("GET", f"/v1/admin/traces/{rid}", user_id=users["user"]), 403, "FORBIDDEN")
    t = assert_ok(client.call("GET", f"/v1/admin/traces/{rid}", user_id=users["admin"]), 200)["data"]
    assert t["request_id"] == rid and t["executions"][0]["workflow"] == "wf.api.health"
    assert_error(client.call("GET", f"/v1/admin/traces/{uuid.uuid4()}", user_id=users["admin"]), 404, "NOT_FOUND")
    assert_error(client.call("GET", "/v1/admin/traces/not-a-uuid", user_id=users["admin"]), 404, "NOT_FOUND")
