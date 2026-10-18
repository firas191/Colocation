"""Platform P7 (docs/PLATFORM_SPEC.md 3.3, 9 P7; D-106): flatmate profiles and compatibility, browsing flatmates,
a room posted by a household, saved searches with the daily alert. Test jurisdiction QF.
"""
import os
import uuid

import psycopg
import pytest

from conftest import assert_error, assert_ok
from test_profile_search import make_user


def idem():
    return "t-" + uuid.uuid4().hex


def c(client, method, path, uid, body=None, params=None):
    return client.call(method, path, user_id=uid, body=body, params=params, idem=idem() if method != "GET" else None)


@pytest.fixture(scope="module")
def p7(client):
    db = psycopg.connect(os.environ["FS_TEST_DB_DSN"], autocommit=True)
    db.execute("""insert into app.jurisdictions (code, country_code, name, default_currency, default_locale, languages, timezone)
                  values ('QF', 'QF', 'Test jurisdiction P7 (tests only)', 'TND', 'fr-TN', '{fr}', 'UTC') on conflict (code) do nothing""")
    u = {k: make_user(db, "user", ("terms", "privacy"), jurisdiction="QF") for k in ("a", "b", "c")}
    for k, prefs, langs in (("a", '{"smoking": "no", "pets": "ok"}', "{fr}"), ("b", '{"smoking": "no", "pets": "no"}', "{fr,en}")):
        db.execute("""insert into app.profiles (user_id, jurisdiction_code, declared_preferences, languages, budget_max_minor, currency, budget_period)
                      values (%s, 'QF', %s, %s, 500000, 'TND', 'month')""", (u[k], prefs, langs))
    yield {"db": db, **u}
    db.close()


def test_profile_and_browse(client, p7):
    a, b, cc = p7["a"], p7["b"], p7["c"]
    r = assert_ok(c(client, "GET", "/v1/me/flatmate-profile", a), 200, "FlatmateProfileMineResponse")["data"]
    assert r["profile"] is None and r["has_lifestyle"] is True
    assert_ok(c(client, "PUT", "/v1/me/flatmate-profile", a, {"visible": True, "headline": "Calme", "seeking": "room"}), 200,
              "FlatmateProfileMineResponse")
    assert_ok(c(client, "PUT", "/v1/me/flatmate-profile", cc, {"visible": False, "headline": "Caché"}), 200)
    lst = assert_ok(c(client, "GET", "/v1/flatmates", b), 200, "FlatmatesResponse")["data"]["items"]
    ids = [x["user"]["user_id"] for x in lst]
    assert a in ids and cc not in ids, "visible profiles only"
    mine = next(x for x in lst if x["user"]["user_id"] == a)["compatibility"]
    states = {f["factor"]: f["state"] for f in mine["factors"]}
    assert states["smoking"] == "match" and states["pets"] == "differs" and states["schedule"] == "unknown"
    assert 0 <= mine["score"] <= 100
    one = assert_ok(c(client, "GET", f"/v1/flatmates/{a}", b), 200, "FlatmateResponse")["data"]
    assert one["compatibility"]["score"] == mine["score"]
    assert_error(c(client, "GET", f"/v1/flatmates/{cc}", b), 404, "NOT_FOUND")
    assert_error(c(client, "PUT", "/v1/me/flatmate-profile", a, {"visible": True, "bio": "x" * 601}), 422, "VALIDATION_FAILED")
    # blocks hide profiles both ways: db/tests/250 (a block needs a conversation between the two first)


def test_saved_search_alert_once(client, p7):
    a, db = p7["a"], p7["db"]
    s = assert_ok(c(client, "POST", "/v1/me/saved-searches", a, {"name": "Chambres QF", "query": {"jurisdiction": "QF", "kind": "room"}}),
                  201, "SavedSearchResponse")["data"]
    assert s["alert"] == "daily" and s["hits"] == 0
    assert_error(c(client, "POST", "/v1/me/saved-searches", a, {"name": "x", "query": {"cursor": "abc"}}), 422, "VALIDATION_FAILED")
    assert_error(c(client, "POST", "/v1/me/saved-searches", a, {"name": "x", "query": {"bbox": "0,0,100,10"}}), 422, "VALIDATION_FAILED")
    lid = str(uuid.uuid4())
    db.execute("""insert into app.listings (id, owner_id, jurisdiction_code, status, kind, title, description, published_at)
                  values (%s, %s, 'QF', 'published', 'room', 'Chambre QF', 'x', now() + interval '1 second')""", (lid, p7["c"]))
    first = db.execute("select social.daily_alerts()").fetchone()[0]
    assert first["listings"] >= 1
    assert db.execute("select social.daily_alerts()").fetchone()[0]["listings"] == 0, "a second run the same day sends nothing"
    lst = assert_ok(c(client, "GET", "/v1/me/saved-searches", a), 200, "SavedSearchesResponse")["data"]["items"]
    assert next(x for x in lst if x["saved_search_id"] == s["saved_search_id"])["hits"] == 1
    n = assert_ok(c(client, "GET", "/v1/me/notifications", a), 200)["data"]["items"]
    assert len([x for x in n if x["type"] == "saved_search_match"]) == 1, "each listing is sent once"
    assert_error(c(client, "DELETE", f"/v1/me/saved-searches/{s['saved_search_id']}", p7["b"]), 404, "NOT_FOUND")
    assert_ok(c(client, "DELETE", f"/v1/me/saved-searches/{s['saved_search_id']}", a), 200, "SavedSearchDeletedResponse")
    db.execute("delete from app.listings where id = %s", (lid,))


def test_room_post(client, p7):
    a, b = p7["a"], p7["b"]
    h = assert_ok(c(client, "POST", "/v1/households", a, {"name": "Coloc QF", "jurisdiction_code": "QF"}), 201)["data"]["household_id"]
    r = assert_ok(c(client, "POST", f"/v1/households/{h}/room-posts", a, {"title": "Chambre libre"}), 201, "RoomPostResponse")["data"]
    assert r["status"] == "draft"
    mine = assert_ok(c(client, "GET", "/v1/me/listings", a), 200)["data"]["items"]
    assert any(x["listing_id"] == r["listing_id"] for x in mine), "the draft is on the owner pages"
    assert_error(c(client, "POST", f"/v1/households/{h}/room-posts", a, {}), 409, "CONFLICT")
    assert_error(c(client, "POST", f"/v1/households/{h}/room-posts", b, {}), 404, "NOT_FOUND")
