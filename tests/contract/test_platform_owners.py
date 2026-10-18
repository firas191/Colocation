"""Platform P3 (docs/PLATFORM_SPEC.md 3.5, 9 P3; D-102): POST /v1/listings/{id}/submit and GET /v1/me/listings, and the
open point of D-077: a second analysis does not overwrite a field the owner changed.

One listing goes the whole way through the API, as the website does it: created from text without a rent or a place,
three photos uploaded to presigned URLs, analysed, corrected with PATCH (rent, place), analysed again, submitted,
found in the search, archived and published again. Test jurisdiction QW with one place of its own.
"""
import json
import os
import uuid

import psycopg
import pytest

from conftest import assert_error, assert_ok
from test_intake_media import photo, put_upload
from test_profile_search import make_user, wait_job

QW = "QW"
CONSENTS = ("terms", "privacy", "media_processing")
TEXT = "Chambre meublée près du parc, wifi et bureau, libre en novembre"   # no rent and no place on purpose


def idem():
    return "t-" + uuid.uuid4().hex


@pytest.fixture(scope="module")
def p3(client):
    db = psycopg.connect(os.environ["FS_TEST_DB_DSN"], autocommit=True)
    db.execute("""insert into app.jurisdictions (code, country_code, name, default_currency, default_locale, languages, timezone)
                  values ('QW', 'QW', 'Test jurisdiction P3 (tests only)', 'TND', 'fr-TN', '{fr,ar}', 'Africa/Tunis')
                  on conflict (code) do nothing""")
    db.execute("delete from app.listings where jurisdiction_code = 'QW'")
    db.execute("delete from app.places where jurisdiction_code = 'QW'")
    db.execute("""insert into app.places (jurisdiction_code, kind, name, place_key, city, location, source)
                  values ('QW', 'neighbourhood', 'Quartier Tilleul', 'qw-tilleul', 'Tilleulville',
                          st_setsrid(st_makepoint(10.4, 36.4), 4326)::geography, 'test')""")
    db.execute("insert into app.place_names (place_id, name) select id, 'Quartier Tilleul' from app.places where place_key = 'qw-tilleul'")
    owner = make_user(db, "user", CONSENTS, jurisdiction=QW)
    other = make_user(db, "user", CONSENTS, jurisdiction=QW)
    seeker = make_user(db, "user", CONSENTS, jurisdiction=QW)
    no_consent = make_user(db, "user", (), jurisdiction=QW)
    vision = db.execute("select value from app.settings where key = 'vision.enabled'").fetchone()[0]
    db.execute("update app.settings set value = 'false' where key = 'vision.enabled'")        # photos only, no P7 call
    # The owner may have turned on automatic publication for Telegram demos (D-083, RUNBOOK); with it on, the PATCH
    # that adds the rent would publish the draft before submit is tested (F-077). Off for this module, then restored.
    auto = db.execute("select value from app.settings where key = 'listing.auto_publish'").fetchone()[0]
    db.execute("update app.settings set value = 'false' where key = 'listing.auto_publish'")
    # The trust check still runs on submit (rules and database checks); the Trust agent is off for this module: on the
    # PC it makes the synchronous v1 submit outlast the client (T-77) and its verdicts are the trust bench's business.
    agent = db.execute("select value from app.settings where key = 'trust.agent_enabled'").fetchone()[0]
    db.execute("update app.settings set value = 'false' where key = 'trust.agent_enabled'")
    try:
        lid = assert_ok(client.call("POST", "/v1/listings", body={"text": TEXT, "jurisdiction_code": "QW"}, user_id=owner, idem=idem()),
                        201, "ListingCreatedResponse")["data"]["listing_id"]
        files = [{"kind": "photo", "content_type": "image/jpeg", "bytes": 300000}] * 3
        ups = assert_ok(client.call("POST", f"/v1/listings/{lid}/media/presign", body={"files": files}, user_id=owner, idem=idem()),
                        200, "PresignResponse")["data"]["uploads"]
        for i, u in enumerate(ups):
            assert put_upload(u, photo(50 + i, gps=False)).status_code == 200
        r = client.call("POST", f"/v1/listings/{lid}/analyze", body={}, user_id=owner, idem=idem())
        job = wait_job(client, owner, assert_ok(r, 202, "JobAcceptedResponse")["data"]["status_url"])
        assert job["status"] == "succeeded" and job["output"]["processed"] == 3, job
    finally:
        db.execute("update app.settings set value = %s where key = 'vision.enabled'", (json.dumps(vision),))
    try:
        yield {"db": db, "owner": owner, "other": other, "seeker": seeker, "no_consent": no_consent, "L": lid, "vision": vision}
    finally:
        db.execute("update app.settings set value = %s where key = 'listing.auto_publish'", (json.dumps(auto),))
        db.execute("update app.settings set value = %s where key = 'trust.agent_enabled'", (json.dumps(agent),))
    db.execute("delete from app.rate_counters where bucket like 'ip:%'")
    db.close()


def mine(client, uid, **params):
    return client.call("GET", "/v1/me/listings", user_id=uid, params={k: str(v) for k, v in params.items()})


def item(client, p3, lid=None):
    j = assert_ok(mine(client, p3["owner"], listing_id=lid or p3["L"]), 200, "MyListingsResponse")
    assert len(j["data"]["items"]) == 1, j
    return j["data"]["items"][0]


# ---------- access ----------------------------------------------------------------------------------------------------
def test_submit_needs_signature_user_and_consent(client, p3):
    path = f"/v1/listings/{p3['L']}/submit"
    assert_error(client.call("POST", path, body={}, idem=idem()), 401, "UNAUTHENTICATED")
    url, h, b = client.build("POST", path, body={}, user_id=p3["owner"], idem=idem())
    h["X-User-Id"] = p3["other"]                       # signed for the owner, sent as someone else
    assert_error(client.send("POST", url, h, b), 401, "UNAUTHENTICATED")
    j = assert_error(client.call("POST", path, body={}, user_id=p3["no_consent"], idem=idem()), 403, "CONSENT_REQUIRED")
    assert j["error"]["details"][0]["purpose"] in ("terms", "privacy")
    assert_error(mine(client, p3["no_consent"]), 403, "CONSENT_REQUIRED")
    assert_error(client.call("GET", "/v1/me/listings"), 401, "UNAUTHENTICATED")


def test_someone_elses_listing_is_404(client, p3):
    assert_error(client.call("POST", f"/v1/listings/{p3['L']}/submit", body={}, user_id=p3["other"], idem=idem()), 404, "NOT_FOUND")
    assert_error(client.call("POST", f"/v1/listings/{uuid.uuid4()}/submit", body={}, user_id=p3["owner"], idem=idem()), 404, "NOT_FOUND")
    assert_error(client.call("POST", "/v1/listings/not-a-uuid/submit", body={}, user_id=p3["owner"], idem=idem()), 404, "NOT_FOUND")
    j = assert_ok(mine(client, p3["other"]), 200, "MyListingsResponse")
    assert j["data"]["items"] == [] and j["data"]["counts"]["all"] == 0
    j = assert_ok(mine(client, p3["other"], listing_id=p3["L"]), 200, "MyListingsResponse")
    assert j["data"]["items"] == [], "another owner's listing is not listed, even by its id"


def test_validation(client, p3):
    j = assert_error(mine(client, p3["owner"], limit=500, status="sold", cursor="x", listing_id="nope", foo=1), 422, "VALIDATION_FAILED")
    assert {d["field"] for d in j["error"]["details"]} == {"limit", "status", "cursor", "listing_id", "foo"}
    j = assert_error(client.call("POST", f"/v1/listings/{p3['L']}/submit", body={"publish": True}, user_id=p3["owner"], idem=idem()),
                     422, "VALIDATION_FAILED")
    assert j["error"]["details"][0]["field"] == "publish"
    assert_error(client.call("POST", f"/v1/listings/{p3['L']}/submit", body={}, user_id=p3["owner"]), 422, "VALIDATION_FAILED")  # no key


# ---------- the draft after the first analysis ------------------------------------------------------------------------
def test_draft_says_what_is_missing(client, p3):
    it = item(client, p3)
    assert it["status"] == "draft" and it["number"] == 1 and it["photo_count"] == 3
    assert it["display_title"] == TEXT
    assert it["readiness"]["ready"] is False
    assert it["readiness"]["missing"] == [{"field": "rent", "issue": "required"}, {"field": "place", "issue": "required"}], it
    assert "rent_missing" in it["readiness"]["issues"]
    assert it["actions"] == {"edit": True, "analyze": True, "submit": False, "archive": True, "republish": False, "view": False}
    assert it["analysis"]["status"] == "succeeded"
    assert it["cover_photo"] and it["cover_photo"]["url"].startswith("http"), it
    assert "location" not in json.dumps(it)
    j = assert_error(client.call("POST", f"/v1/listings/{p3['L']}/submit", body={}, user_id=p3["owner"], idem=idem()),
                     422, "VALIDATION_FAILED")
    assert j["error"]["details"] == [{"field": "rent", "issue": "required"}, {"field": "place", "issue": "required"}]


def test_second_analysis_keeps_what_the_owner_changed(client, p3):
    """D-077: the owner fixes the rent and the place; a new analysis of the same text (no rent in it) leaves them."""
    o, lid = p3["owner"], p3["L"]
    ch = assert_ok(client.call("PATCH", f"/v1/listings/{lid}", body={"rent": 450, "place": "Quartier Tilleul", "bedrooms": 2},
                               user_id=o, idem=idem()), 200, "ListingChangeResponse")["data"]
    assert {d["field"] for d in ch["diff"]} == {"rent", "place", "bedrooms"}
    db = p3["db"]
    db.execute("update app.settings set value = 'false' where key = 'vision.enabled'")
    try:
        r = client.call("POST", f"/v1/listings/{lid}/analyze", body={}, user_id=o, idem=idem())
        job = wait_job(client, o, assert_ok(r, 202, "JobAcceptedResponse")["data"]["status_url"])
        assert job["status"] == "succeeded", job
    finally:
        db.execute("update app.settings set value = %s where key = 'vision.enabled'", (json.dumps(p3["vision"]),))
    v = assert_ok(client.call("GET", f"/v1/listings/{lid}", user_id=o), 200, "ListingResponse")["data"]
    assert v["rent_minor"] == 450000 and v["currency"] == "TND", "the analysis did not take back the owner's rent"
    assert v["neighbourhood"] == "Quartier Tilleul" and v["bedrooms"] == 2
    assert set(v["extraction"]["kept_owner_fields"]) >= {"rent_minor", "currency", "city", "neighbourhood", "bedrooms"}
    assert len(v["extraction"]["owner_changes"]) == 1, "the owner's change history survives the new analysis"
    it = item(client, p3)
    assert it["readiness"]["ready"] is True and it["readiness"]["missing"] == [] and it["readiness"]["photos"] == 3
    assert "rent_missing" not in it["readiness"]["issues"], "a rent is set: the analysis issue no longer applies"
    assert it["actions"]["submit"] is True


def test_submit_while_an_analysis_runs(client, p3):
    db, o = p3["db"], p3["owner"]
    lid = assert_ok(client.call("POST", "/v1/listings", body={"text": "Deuxième annonce 300 DT", "jurisdiction_code": "QW"},
                                user_id=o, idem=idem()), 201)["data"]["listing_id"]
    job = db.execute("insert into app.jobs (type, status, input) values ('listing_analyze', 'running', %s) returning id",
                     (json.dumps({"listing_id": lid}),)).fetchone()[0]
    try:
        j = assert_error(client.call("POST", f"/v1/listings/{lid}/submit", body={}, user_id=o, idem=idem()), 409, "CONFLICT")
        assert j["error"]["details"] == [{"field": "analysis", "issue": "running", "job_id": str(job)}]
        it = item(client, p3, lid)
        assert it["actions"]["submit"] is False and it["analysis"]["status"] == "running"
        assert it["number"] == 1, "the newest listing is number 1, as for the owner assistant"
    finally:
        db.execute("update app.jobs set status = 'cancelled', finished_at = now() where id = %s", (job,))


# ---------- publish, repeat, search, archive, publish again -------------------------------------------------------------
def test_submit_publishes_once(client, p3):
    o, lid = p3["owner"], p3["L"]
    key = idem()
    first = client.call("POST", f"/v1/listings/{lid}/submit", body={}, user_id=o, idem=key)
    d = assert_ok(first, 200, "ListingSubmitResponse")["data"]
    # checked: the trust check ran first (P8, D-107); the listing is honest, so it is published at once
    assert d["status"] == "published" and d["place"] == "Quartier Tilleul" and d["checked"] is True
    assert d["title"] == TEXT
    replay = client.call("POST", f"/v1/listings/{lid}/submit", body={}, user_id=o, idem=key)
    assert replay.status_code == 200 and replay.json() == first.json(), "same key: the stored answer"
    assert_error(client.call("POST", f"/v1/listings/{lid}/submit", body={"x": 1}, user_id=o, idem=key), 409, "CONFLICT")
    again = assert_ok(client.call("POST", f"/v1/listings/{lid}/submit", body={}, user_id=o, idem=idem()), 200, "ListingSubmitResponse")
    assert {k: v for k, v in again["data"].items() if k != "warnings"} == {k: v for k, v in d.items() if k != "warnings"}, \
        "submitting a published listing again: the same answer"
    db = p3["db"]
    assert db.execute("select count(*) from app.audit_log where action = 'listing_submitted' and entity_id = %s", (lid,)).fetchone()[0] == 1
    # a seeker finds it, without the exact location
    s = assert_ok(client.call("GET", "/v2/search", user_id=p3["seeker"], params={"jurisdiction": QW}), 200, "SearchV2Response")
    assert lid in [x["id"] for x in s["data"]["results"]]
    pub = assert_ok(client.call("GET", f"/v1/listings/{lid}/public", user_id=p3["seeker"]), 200)["data"]
    assert pub["listing"]["status"] == "published" and "location" not in pub["listing"] and len(pub["photos"]) == 3
    it = item(client, p3)
    assert it["status"] == "published" and it["readiness"] is None
    assert it["actions"] == {"edit": True, "analyze": False, "submit": False, "archive": True, "republish": False, "view": True}


def test_owner_is_notified(client, p3):
    j = assert_ok(client.call("GET", "/v1/me/notifications", user_id=p3["owner"]), 200, "NotificationsResponse")["data"]
    mine_ = [x for x in j["items"] if x["type"] == "listing_published" and x["link_id"] == p3["L"]]
    assert len(mine_) == 1 and mine_[0]["link_kind"] == "listing"


def test_archive_and_publish_again(client, p3):
    o, lid = p3["owner"], p3["L"]
    assert assert_ok(client.call("PATCH", f"/v1/listings/{lid}", body={"status": "archived"}, user_id=o, idem=idem()), 200)["data"]["status"] == "archived"
    it = item(client, p3)
    assert it["status"] == "archived" and it["actions"]["republish"] is True and it["actions"]["view"] is False
    j = assert_error(client.call("POST", f"/v1/listings/{lid}/submit", body={}, user_id=o, idem=idem()), 409, "CONFLICT")
    assert j["error"]["details"] == [{"field": "status", "issue": "status_not_allowed", "current": "archived"}]
    s = assert_ok(client.call("GET", "/v2/search", user_id=p3["seeker"], params={"jurisdiction": QW}), 200)
    assert lid not in [x["id"] for x in s["data"]["results"]], "an archived listing is not found"
    assert_error(client.call("GET", f"/v1/listings/{lid}/public", user_id=p3["seeker"]), 404, "NOT_FOUND")
    assert assert_ok(client.call("PATCH", f"/v1/listings/{lid}", body={"status": "published"}, user_id=o, idem=idem()), 200)["data"]["status"] == "published"
    s = assert_ok(client.call("GET", "/v2/search", user_id=p3["seeker"], params={"jurisdiction": QW}), 200)
    assert lid in [x["id"] for x in s["data"]["results"]]


def test_my_listings_pages_and_filters(client, p3):
    o = p3["owner"]
    j = assert_ok(mine(client, o), 200, "MyListingsResponse")
    assert j["data"]["counts"] == {"all": 2, "draft": 1, "published": 1, "archived": 0}
    assert [x["number"] for x in j["data"]["items"]] == [1, 2] and j["meta"]["next_cursor"] is None
    first = assert_ok(mine(client, o, limit=1), 200, "MyListingsResponse")
    assert len(first["data"]["items"]) == 1 and first["meta"]["next_cursor"]
    second = assert_ok(mine(client, o, limit=1, cursor=first["meta"]["next_cursor"]), 200, "MyListingsResponse")
    assert [x["listing_id"] for x in second["data"]["items"]] == [p3["L"]] and second["meta"]["next_cursor"] is None
    pub = assert_ok(mine(client, o, status="published"), 200)
    assert [x["listing_id"] for x in pub["data"]["items"]] == [p3["L"]]
