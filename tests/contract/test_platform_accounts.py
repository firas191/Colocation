"""Platform P1 (docs/PLATFORM_SPEC.md 9): GET /v1/me, GET /v1/profiles/me, GET /v1/me/notifications,
POST /v1/me/notifications/read. Data reached through the row-level layer of migration 0022 (D-096)."""
import os

import psycopg
import pytest

from conftest import assert_error, assert_ok
from test_profile_search import make_user

PROFILE = {"jurisdiction_code": "QX", "budget_max_minor": 450000, "currency": "TND", "budget_period": "month",
           "declared_preferences": {"smoking": "no", "pets": "yes", "schedule": "early", "cleanliness": "high",
                                    "guests": "yes", "quiet_hours": "yes"},
           "languages": ["fr", "ar"], "move_in_from": "2026-11-01", "min_stay_months": 6}


@pytest.fixture(scope="module")
def people():
    db = psycopg.connect(os.environ["FS_TEST_DB_DSN"], autocommit=True)
    db.execute("""insert into app.jurisdictions (code, country_code, name, default_currency, default_locale, languages, timezone)
                  values ('QX', 'QX', 'Test jurisdiction (tests only)', 'TND', 'fr-TN', '{fr,ar}', 'Africa/Tunis') on conflict do nothing""")
    p = {"amel": make_user(db, "user"), "bilel": make_user(db, "user"), "fresh": make_user(db, "user", ()),
         "termsonly": make_user(db, "user", ("terms",)), "admin": make_user(db, "admin")}
    db.execute("delete from app.rate_counters where bucket like 'ip:%'")
    db.close()
    return p


def emit(db, uid, kind, params="{}", link_kind=None, link_id=None):
    return db.execute("select api.notify_emit(%s, %s, %s::jsonb, %s, %s)", (uid, kind, params, link_kind, link_id)).fetchone()[0]


# ---------- GET /v1/me -----------------------------------------------------------------------------------------------
def test_me_without_consent_says_what_is_required(client, people):
    d = assert_ok(client.call("GET", "/v1/me", user_id=people["fresh"]), 200, "MeResponse")["data"]
    assert d["user_id"] == people["fresh"]
    assert d["consent_required"] == ["terms", "privacy"] and d["consents"] == {}
    assert d["flags"] == {"has_profile": False, "has_listings": False, "is_staff": False, "telegram_linked": False}
    assert d["counts"] == {"unread_notifications": 0, "listings": 0}
    d = assert_ok(client.call("GET", "/v1/me", user_id=people["termsonly"]), 200, "MeResponse")["data"]
    assert d["consent_required"] == ["privacy"]


def test_me_flags_and_jurisdictions(client, people, db):
    d = assert_ok(client.call("GET", "/v1/me", user_id=people["admin"]), 200, "MeResponse")["data"]
    assert d["flags"]["is_staff"] is True and d["role"] == "admin"
    qx = next(j for j in d["jurisdictions"] if j["code"] == "QX")
    assert qx["currency"] == "TND" and qx["exponent"] == 3
    db.execute("insert into app.listings (owner_id, jurisdiction_code, status, description) values (%s, 'QX', 'draft', 'x')",
               (people["bilel"],))
    d = assert_ok(client.call("GET", "/v1/me", user_id=people["bilel"]), 200, "MeResponse")["data"]
    assert d["flags"]["has_listings"] is True and d["counts"]["listings"] == 1
    d = assert_ok(client.call("GET", "/v1/me", user_id=people["amel"]), 200, "MeResponse")["data"]
    assert d["flags"]["has_listings"] is False, "another user's draft is not counted"


def test_me_needs_a_user(client):
    assert_error(client.call("GET", "/v1/me"), 401, "UNAUTHENTICATED")
    assert_error(client.call("GET", "/v1/me", user_id="00000000-0000-4000-8000-0000000000ff"), 401, "UNAUTHENTICATED")


def test_me_rejects_query_parameters(client, people):
    j = assert_error(client.call("GET", "/v1/me", params={"x": "1"}, user_id=people["amel"]), 422, "VALIDATION_FAILED")
    assert j["error"]["details"] == [{"field": "x", "issue": "unknown_parameter"}]


def test_signature_is_checked(client, people):
    url, h, b = client.build("GET", "/v1/me", user_id=people["amel"])
    h["X-User-Id"] = people["bilel"]                       # signed for Amel, sent as Bilel
    assert_error(client.send("GET", url, h, b), 401, "UNAUTHENTICATED")


# ---------- GET /v1/profiles/me ------------------------------------------------------------------------------------
def test_profile_get_before_and_after_saving(client, people, idem):
    d = assert_ok(client.call("GET", "/v1/profiles/me", user_id=people["amel"]), 200, "ProfileGetResponse")["data"]
    assert d == {"profile": None}
    assert_ok(client.call("PUT", "/v1/profiles/me", body=PROFILE, user_id=people["amel"], idem=idem()), 200, "ProfileResponse")
    p = assert_ok(client.call("GET", "/v1/profiles/me", user_id=people["amel"]), 200, "ProfileGetResponse")["data"]["profile"]
    assert p["budget_max_minor"] == 450000 and p["currency"] == "TND"
    assert p["declared_preferences"] == PROFILE["declared_preferences"]
    assert p["languages"] == ["fr", "ar"] and p["move_in_from"] == "2026-11-01" and p["profile_version"] == 1
    other = assert_ok(client.call("GET", "/v1/profiles/me", user_id=people["bilel"]), 200, "ProfileGetResponse")["data"]
    assert other == {"profile": None}, "Bilel does not get Amel's profile"
    d = assert_ok(client.call("GET", "/v1/me", user_id=people["amel"]), 200, "MeResponse")["data"]
    assert d["flags"]["has_profile"] is True


def test_profile_get_needs_consent(client, people):
    j = assert_error(client.call("GET", "/v1/profiles/me", user_id=people["termsonly"]), 403, "CONSENT_REQUIRED")
    assert j["error"]["details"] == [{"purpose": "privacy"}]


# ---------- notifications -------------------------------------------------------------------------------------------
def test_notifications_are_private_and_paged(client, people, db, idem):
    a, b = people["amel"], people["bilel"]
    for i in range(3):
        assert emit(db, a, "visit_requested", f'{{"n": {i}}}', "visit", f"v{i}") is True
    assert emit(db, b, "welcome") is True
    d = assert_ok(client.call("GET", "/v1/me/notifications", params={"limit": "2"}, user_id=a), 200, "NotificationsResponse")["data"]
    assert [x["params"]["n"] for x in d["items"]] == [2, 1] and d["unread"] == 3 and d["next_before"] is not None
    d2 = assert_ok(client.call("GET", "/v1/me/notifications", params={"limit": "2", "before": str(d["next_before"])}, user_id=a),
                   200, "NotificationsResponse")["data"]
    assert [x["params"]["n"] for x in d2["items"]] == [0] and d2["next_before"] is None
    mine = assert_ok(client.call("GET", "/v1/me/notifications", user_id=b), 200, "NotificationsResponse")["data"]
    assert [x["type"] for x in mine["items"]] == ["welcome"]

    # Bilel cannot mark Amel's as read, even with their ids.
    ids = [x["id"] for x in d["items"]]
    r = assert_ok(client.call("POST", "/v1/me/notifications/read", body={"ids": ids}, user_id=b, idem=idem()), 200,
                  "NotificationsReadResponse")["data"]
    assert r["updated"] == 0 and r["unread"] == 1
    r = assert_ok(client.call("POST", "/v1/me/notifications/read", body={"ids": ids[:1]}, user_id=a, idem=idem()), 200,
                  "NotificationsReadResponse")["data"]
    assert r == {"updated": 1, "unread": 2}
    unread = assert_ok(client.call("GET", "/v1/me/notifications", params={"unread_only": "true"}, user_id=a), 200)["data"]
    assert len(unread["items"]) == 2
    r = assert_ok(client.call("POST", "/v1/me/notifications/read", body={"all": True}, user_id=a, idem=idem()), 200)["data"]
    assert r == {"updated": 2, "unread": 0}
    me = assert_ok(client.call("GET", "/v1/me", user_id=a), 200, "MeResponse")["data"]
    assert me["counts"]["unread_notifications"] == 0


def test_notifications_validation(client, people, idem):
    a = people["amel"]
    j = assert_error(client.call("GET", "/v1/me/notifications", params={"limit": "500", "unread_only": "yes", "x": "1"}, user_id=a),
                     422, "VALIDATION_FAILED")
    assert {d["field"] for d in j["error"]["details"]} == {"limit", "unread_only", "x"}
    j = assert_error(client.call("POST", "/v1/me/notifications/read", body={}, user_id=a, idem=idem()), 422, "VALIDATION_FAILED")
    assert j["error"]["details"] == [{"field": "ids|all", "issue": "one_required"}]
    assert_error(client.call("POST", "/v1/me/notifications/read", body={"ids": ["x"], "all": False}, user_id=a, idem=idem()),
                 422, "VALIDATION_FAILED")
    assert_error(client.call("POST", "/v1/me/notifications/read", body={"all": True}, user_id=a), 422, "VALIDATION_FAILED")  # no key
    assert_error(client.call("GET", "/v1/me/notifications", user_id=people["fresh"]), 403, "CONSENT_REQUIRED")


def test_notifications_read_is_idempotent(client, people, db, idem):
    a = people["amel"]
    emit(db, a, "welcome")
    key = idem()
    first = assert_ok(client.call("POST", "/v1/me/notifications/read", body={"all": True}, user_id=a, idem=key), 200)
    again = client.call("POST", "/v1/me/notifications/read", body={"all": True}, user_id=a, idem=key)
    assert again.status_code == 200 and again.json() == first      # the stored answer, with the first request_id
    assert_error(client.call("POST", "/v1/me/notifications/read", body={"ids": [1]}, user_id=a, idem=key), 409, "CONFLICT")
