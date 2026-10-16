"""Platform P2 (docs/PLATFORM_SPEC.md 3.2, 3.5, 9): GET /v2/search, GET /v1/listings/{id}/public with signed photo URLs,
favourites, POST /v1/listing-changes/{id}/cancel. GET /v1/search is checked unchanged in test_profile_search.py.

Listings are written directly in their own test jurisdiction (QY) with known fields, so every filter has an exact
expected answer. One listing gets two real photos through the normal path (presigned upload, analysis job), so the
photo URLs point at processed copies in the storage (Garage on the PC, the S3 stand-in in the sandbox).
"""
import json
import os
import time
import uuid
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

import httpx
import psycopg
import pytest

from conftest import assert_error, assert_ok
from test_intake_media import photo, put_upload
from test_profile_search import make_user, wait_job

QY = "QY"
L_A = "00000000-0000-4000-8000-0000000000a1"     # gets the photos (created through the API, id assigned there)
L_B = "00000000-0000-4000-8000-0000000000b2"
L_C = "00000000-0000-4000-8000-0000000000c3"
L_D = "00000000-0000-4000-8000-0000000000d4"     # the owner's draft
CONSENTS = ("terms", "privacy", "media_processing")
# the S3 stand-in of the sandbox checks neither signatures nor expiry; Garage on the PC does
real_storage_only = pytest.mark.skipif(os.environ.get("FS_SANDBOX_MOCKS") == "1", reason="needs a storage that checks signatures")


@pytest.fixture(scope="module")
def p2(client):
    db = psycopg.connect(os.environ["FS_TEST_DB_DSN"], autocommit=True)
    db.execute("""insert into app.jurisdictions (code, country_code, name, default_currency, default_locale, languages, timezone)
                  values ('QY', 'QY', 'Test jurisdiction P2 (tests only)', 'TND', 'fr-TN', '{fr,ar}', 'Africa/Tunis')
                  on conflict (code) do nothing""")
    db.execute("delete from app.listings where jurisdiction_code = 'QY'")
    owner = make_user(db, "owner", CONSENTS, jurisdiction=QY)
    seeker = make_user(db, "user", CONSENTS, jurisdiction=QY)
    other = make_user(db, "user", CONSENTS, jurisdiction=QY)
    admin = make_user(db, "admin", CONSENTS, jurisdiction=QY)
    no_consent = make_user(db, "user", (), jurisdiction=QY)
    vision = db.execute("select value from app.settings where key = 'vision.enabled'").fetchone()[0]
    db.execute("update app.settings set value = 'false' where key = 'vision.enabled'")        # photos only, no P7 call
    try:
        # A: through the API, with two photos processed by the analysis job
        idem = lambda: "t-" + uuid.uuid4().hex   # noqa: E731
        a = assert_ok(client.call("POST", "/v1/listings", body={"text": "Chambre meublée centre wifi, 400 DT", "jurisdiction_code": "qy"},
                                  user_id=owner, idem=idem()), 201, "ListingCreatedResponse")["data"]["listing_id"]
        files = [{"kind": "photo", "content_type": "image/jpeg", "bytes": 300000}] * 2
        ups = assert_ok(client.call("POST", f"/v1/listings/{a}/media/presign", body={"files": files}, user_id=owner, idem=idem()),
                        200, "PresignResponse")["data"]["uploads"]
        for i, u in enumerate(ups):
            assert put_upload(u, photo(30 + i, gps=False)).status_code == 200
        r = client.call("POST", f"/v1/listings/{a}/analyze", body={}, user_id=owner, idem=idem())
        job = wait_job(client, owner, assert_ok(r, 202, "JobAcceptedResponse")["data"]["status_url"])
        assert job["status"] == "succeeded" and job["output"]["processed"] == 2, job
    finally:
        db.execute("update app.settings set value = %s where key = 'vision.enabled'", (json.dumps(vision),))
    # every field set here, whatever the extraction wrote
    common = "jurisdiction_code = 'QY', currency = 'TND', city = 'Testville', is_synthetic = true, source = 'synthetic'"
    db.execute(f"""update app.listings set {common}, status = 'published', published_at = now() - interval '3 hours', kind = 'room',
                   title = 'Chambre meublée centre wifi', description = 'Chambre calme, wifi et bureau', rent_minor = 400000,
                   rent_period = 'month', furnished = true, bills_included = true, available_from = '2026-11-01',
                   amenities = '{{wifi,desk}}', house_rules = '{{"smoking": "no"}}',
                   location = st_setsrid(st_makepoint(10.0012, 36.0011), 4326)::geography where id = %s""", (a,))
    rows = ((L_B, "shared_flat", "Colocation jardin parking", "Grande colocation avec jardin", 700000, False, False, "2027-01-15",
             "{parking}", '{"pets": "yes"}', 10.31, 36.31, "published", "2 hours"),
            (L_C, "room", "Chambre balcon", "Chambre avec balcon lumineux", 550000, True, None, None,
             "{wifi,balcony}", '{"smoking": "no", "pets": "no"}', 10.05, 36.02, "published", "1 hour"),
            (L_D, "room", "Brouillon balcon", "Annonce non publiée", 100000, True, True, "2026-11-01",
             "{wifi,desk,balcony}", '{"smoking": "no"}', 10.0, 36.0, "draft", None))
    for lid, kind, title, desc, rent, furn, bills, avail, amen, rules, lng, lat, status, age in rows:
        db.execute(f"""insert into app.listings (id, owner_id, kind, title, description, rent_minor, rent_period, furnished, bills_included,
                                                 available_from, amenities, house_rules, location, status, published_at,
                                                 jurisdiction_code, currency, city, is_synthetic, source)
                       values (%s, %s, %s, %s, %s, %s, 'month', %s, %s, %s, %s, %s::jsonb,
                               st_setsrid(st_makepoint(%s, %s), 4326)::geography, %s,
                               case when %s::text is null then null else now() - %s::interval end,
                               'QY', 'TND', 'Testville', true, 'synthetic')""",
                   (lid, owner, kind, title, desc, rent, furn, bills, avail, amen, rules, lng, lat, status, age, age))
    r = client.call("POST", "/v1/admin/listings/embed", body={}, user_id=admin, idem="t-" + uuid.uuid4().hex)
    job = wait_job(client, admin, assert_ok(r, 202, "JobAcceptedResponse")["data"]["status_url"])
    assert job["status"] == "succeeded", job
    yield {"db": db, "owner": owner, "seeker": seeker, "other": other, "no_consent": no_consent, "A": a}
    db.execute("delete from app.rate_counters where bucket like 'ip:%'")     # many requests from one address (F-045)
    db.close()


def search(client, uid, **params):
    return client.call("GET", "/v2/search", user_id=uid, params={"jurisdiction": QY, **{k: str(v) for k, v in params.items()}})


def ids(j):
    return [x["id"] for x in j["data"]["results"]]


def no_key(obj, key):
    """True when no object anywhere in obj has this key."""
    if isinstance(obj, dict):
        return key not in obj and all(no_key(v, key) for v in obj.values())
    if isinstance(obj, list):
        return all(no_key(v, key) for v in obj)
    return True


def fetch(url, **kw):
    """GET a signed URL. Inside the tests container the proxy has another name (FS_API_BASE); the Host header the
    signature covers is kept."""
    parts = urlsplit(url)
    base = urlsplit(os.environ.get("FS_API_BASE", "http://127.0.0.1:8080"))
    return httpx.get(urlunsplit((base.scheme, base.netloc, parts.path, parts.query, "")), headers={"Host": parts.netloc}, timeout=20, **kw)


# ---------- GET /v2/search -----------------------------------------------------------------------------------------
def test_v2_needs_user_and_consent(client, p2):
    assert_error(client.call("GET", "/v2/search", params={"jurisdiction": QY}), 401, "UNAUTHENTICATED")
    assert_error(search(client, p2["no_consent"]), 403, "CONSENT_REQUIRED")


def test_v2_filters(client, p2):
    A, s = p2["A"], p2["seeker"]
    j = assert_ok(search(client, s), 200, "SearchV2Response")
    assert ids(j) == [L_C, L_B, A], "newest first; the draft is never returned"
    assert j["data"]["mode"] == "filters" and j["data"]["total_matching_filters"] == 3 and j["meta"]["next_cursor"] is None
    cases = [({"kind": "shared_flat"}, [L_B]), ({"furnished": "true"}, [L_C, A]), ({"bills_included": "false"}, [L_B]),
             ({"available_by": "2026-12-01"}, [A]),                       # C has no date: an unknown date does not match
             ({"amenities": "wifi"}, [L_C, A]), ({"amenities": "wifi,desk"}, [A]), ({"amenities": "pool"}, []),
             ({"house_rules": "smoking:no"}, [L_C, A]), ({"house_rules": "smoking:no,pets:no"}, [L_C]),
             ({"bbox": "9.9,35.9,10.1,36.1"}, [L_C, A]), ({"max_rent": 600000}, [L_C, A]),
             ({"furnished": "true", "max_rent": 450000, "amenities": "desk"}, [A])]
    for params, expected in cases:
        j = assert_ok(search(client, s, **params), 200, "SearchV2Response")
        assert ids(j) == expected, (params, ids(j))
        assert j["data"]["total_matching_filters"] == len(expected)
    j = assert_ok(search(client, s, kind="room", furnished="true"), 200, "SearchV2Response")
    assert j["data"]["applied"]["kind"] == "room" and j["data"]["applied"]["furnished"] is True


def test_v2_text_ids_and_near(client, p2):
    s, A = p2["seeker"], p2["A"]
    j = assert_ok(search(client, s, q="balcon"), 200, "SearchV2Response")
    assert j["data"]["mode"] == "hybrid" and ids(j)[0] == L_C and L_D not in ids(j)
    assert j["data"]["applied"]["candidates"] >= 20
    j = assert_ok(search(client, s, ids=f"{L_B},{A},{L_D},{uuid.uuid4()}"), 200, "SearchV2Response")
    assert j["data"]["mode"] == "ids" and ids(j) == [L_B, A], "in the order given; drafts and unknown ids left out"
    j = assert_ok(search(client, s, lat="36.0", lng="10.0", radius_m="10000"), 200, "SearchV2Response")
    assert ids(j) == [A, L_C], "nearest first"


def test_v2_pages(client, p2):
    s = p2["seeker"]
    first = assert_ok(search(client, s, limit=2), 200, "SearchV2Response")
    assert first["data"]["count"] == 2 and [r["rank"] for r in first["data"]["results"]] == [1, 2]
    cur = first["meta"]["next_cursor"]
    assert cur
    second = assert_ok(search(client, s, limit=2, cursor=cur), 200, "SearchV2Response")
    assert ids(second) == [p2["A"]] and second["data"]["results"][0]["rank"] == 3 and second["meta"]["next_cursor"] is None
    j = assert_error(search(client, s, limit=2, cursor=cur, furnished="true"), 422, "VALIDATION_FAILED")
    assert j["error"]["details"] == [{"field": "cursor", "issue": "invalid_cursor"}]


def test_v2_validation(client, p2):
    j = assert_error(search(client, p2["seeker"], kind="castle", amenities="wifi,jacuzzi", house_rules="women:no",
                            bbox="10,37,9,36", available_by="2026-02-30x", foo="1"), 422, "VALIDATION_FAILED")
    assert {(d["field"], d["issue"]) for d in j["error"]["details"]} >= {
        ("kind", "not_allowed"), ("amenities", "unknown_amenity"), ("house_rules", "invalid_format"),
        ("bbox", "min_must_be_below_max"), ("available_by", "invalid_date"), ("foo", "unknown_parameter")}
    # the desktop view of the whole country (F-075) is accepted; more than 90 degrees is not
    assert_ok(search(client, p2["seeker"], bbox="2.63761,33.42386,16.24953,37.74140"), 200, "SearchV2Response")
    j = assert_error(search(client, p2["seeker"], bbox="-50,20,41,40"), 422, "VALIDATION_FAILED")
    assert j["error"]["details"] == [{"field": "bbox", "issue": "too_large", "max_degrees": 90}]
    j = assert_error(search(client, p2["seeker"], jurisdiction="QQ"), 422, "VALIDATION_FAILED")
    assert j["error"]["details"][0]["issue"] == "unknown_jurisdiction"


def test_v2_covers_and_favourite_flag(client, p2, idem):
    s, A = p2["seeker"], p2["A"]
    assert_ok(client.call("PUT", f"/v1/me/favourites/{L_C}", body={}, user_id=s, idem=idem()), 200, "FavouriteResponse")
    res = {x["id"]: x for x in assert_ok(search(client, s), 200, "SearchV2Response")["data"]["results"]}
    assert res[A]["photo_count"] == 2 and res[A]["cover_photo"]["url"]
    assert res[L_B]["cover_photo"] is None and res[L_B]["photo_count"] == 0
    assert res[L_C]["is_favourite"] is True and res[A]["is_favourite"] is False
    r = fetch(res[A]["cover_photo"]["url"])
    assert r.status_code == 200 and r.content[:3] == b"\xff\xd8\xff", "a JPEG of the processed copy"
    other = {x["id"]: x for x in assert_ok(search(client, p2["other"]), 200, "SearchV2Response")["data"]["results"]}
    assert other[L_C]["is_favourite"] is False, "favourites are per user"


def test_v2_and_public_view_never_show_the_exact_location(client, p2):
    db = p2["db"]
    exact = db.execute("select st_y(location::geometry), st_x(location::geometry) from app.listings where id = %s", (p2["A"],)).fetchone()
    for j in (assert_ok(search(client, p2["seeker"]), 200, "SearchV2Response"),
              assert_ok(client.call("GET", f"/v1/listings/{p2['A']}/public", user_id=p2["seeker"]), 200, "PublicListingResponse"),
              assert_ok(client.call("GET", "/v1/me/favourites", user_id=p2["seeker"]), 200, "FavouritesResponse")):
        assert no_key(j, "location") and no_key(j, "owner_id") and no_key(j, "key") and no_key(j, "storage_key")
        text = json.dumps(j)
        assert f"{exact[0]:.5f}" not in text or f"{exact[1]:.5f}" not in text


# ---------- GET /v1/listings/{id}/public ---------------------------------------------------------------------------
def test_public_listing_with_photos(client, p2):
    A = p2["A"]
    d = assert_ok(client.call("GET", f"/v1/listings/{A}/public", user_id=p2["seeker"]), 200, "PublicListingResponse")["data"]
    lst = d["listing"]
    assert lst["id"] == A and lst["status"] == "published" and lst["is_own"] is False and lst["is_favourite"] is False
    assert lst["amenities"] == ["wifi", "desk"] and lst["house_rules"] == {"smoking": "no"} and lst["furnished"] is True
    assert lst["rent"]["amount_minor"] == 400000 and lst["rent"]["exponent"] == 3
    assert d["photo_count"] == 2 and len(d["photos"]) == 2 and d["warnings"] == []
    for p in d["photos"]:
        q = dict(parse_qsl(urlsplit(p["url"]).query))
        assert urlsplit(p["url"]).path.split("/")[2] == "media", "processed copies only"
        assert "X-Amz-Signature" in q and 60 <= int(q["X-Amz-Expires"]) <= 3600
        assert fetch(p["url"]).status_code == 200
    assert d["data_attribution"] == ["openstreetmap"]


def test_public_listing_visibility(client, p2):
    for uid in (p2["seeker"], p2["other"]):
        assert_error(client.call("GET", f"/v1/listings/{L_D}/public", user_id=uid), 404, "NOT_FOUND")
    d = assert_ok(client.call("GET", f"/v1/listings/{L_D}/public", user_id=p2["owner"]), 200, "PublicListingResponse")["data"]
    assert d["listing"]["status"] == "draft" and d["listing"]["is_own"] is True, "the owner sees a preview"
    assert_error(client.call("GET", f"/v1/listings/{uuid.uuid4()}/public", user_id=p2["seeker"]), 404, "NOT_FOUND")
    assert_error(client.call("GET", "/v1/listings/not-a-uuid/public", user_id=p2["seeker"]), 404, "NOT_FOUND")
    assert_error(client.call("GET", f"/v1/listings/{L_B}/public", user_id=p2["no_consent"]), 403, "CONSENT_REQUIRED")
    assert_error(client.call("GET", f"/v1/listings/{L_B}/public", user_id=p2["seeker"], params={"x": "1"}), 422, "VALIDATION_FAILED")
    # the owner view stays the owner's only
    assert_error(client.call("GET", f"/v1/listings/{L_B}", user_id=p2["seeker"]), 404, "NOT_FOUND")


@real_storage_only
def test_photo_url_is_refused_when_tampered_or_expired(client, p2):
    db = p2["db"]
    db.execute("update app.settings set value = '60' where key = 'media.photo_url_ttl_s'")
    try:
        d = assert_ok(client.call("GET", f"/v1/listings/{p2['A']}/public", user_id=p2["seeker"]), 200, "PublicListingResponse")["data"]
    finally:
        db.execute("update app.settings set value = '900' where key = 'media.photo_url_ttl_s'")
    url = d["photos"][0]["url"]
    assert fetch(url).status_code == 200
    parts = urlsplit(url)
    q = dict(parse_qsl(parts.query))
    q["X-Amz-Signature"] = "0" * len(q["X-Amz-Signature"])
    assert fetch(urlunsplit((parts.scheme, parts.netloc, parts.path, urlencode(q), ""))).status_code == 403
    q = dict(parse_qsl(parts.query))                        # another object with this signature
    assert fetch(urlunsplit((parts.scheme, parts.netloc, parts.path.replace(".jpg", "x.jpg"), parts.query, ""))).status_code == 403
    time.sleep(62)
    # Refused once expired. Garage answers 400 for an expired signature, moto (sandbox) 403; both refuse (F-073).
    assert fetch(url).status_code in (400, 403), "expired"


def test_proxy_serves_only_signed_reads_of_processed_photos(client, p2):
    base = os.environ.get("FS_API_BASE", "http://127.0.0.1:8080")
    key = p2["db"].execute("select storage_key from app.listing_media where listing_id = %s limit 1", (p2["A"],)).fetchone()[0]
    assert httpx.get(f"{base}/flatshare-media/{key}", timeout=10).status_code == 404, "no signature: not a route"
    assert httpx.get(f"{base}/flatshare-media/uploads/x.jpg?X-Amz-Signature=1", timeout=10).status_code == 404, "raw uploads never"


# ---------- favourites -----------------------------------------------------------------------------------------------
def test_favourites(client, p2, idem):
    o, A = p2["other"], p2["A"]
    k = idem()
    first = assert_ok(client.call("PUT", f"/v1/me/favourites/{A}", body={}, user_id=o, idem=k), 200, "FavouriteResponse")
    assert first["data"]["favourite"] is True and first["data"]["listing_id"] == A
    replay = client.call("PUT", f"/v1/me/favourites/{A}", body={}, user_id=o, idem=k)
    assert replay.json() == first, "same key: the stored answer"
    again = assert_ok(client.call("PUT", f"/v1/me/favourites/{A}", body={}, user_id=o, idem=idem()), 200, "FavouriteResponse")
    assert again["data"]["saved_at"] == first["data"]["saved_at"], "saving twice keeps the first date"
    assert_ok(client.call("PUT", f"/v1/me/favourites/{L_B}", body={}, user_id=o, idem=idem()), 200, "FavouriteResponse")
    assert_error(client.call("PUT", f"/v1/me/favourites/{L_D}", body={}, user_id=o, idem=idem()), 404, "NOT_FOUND")       # a draft
    assert_error(client.call("PUT", f"/v1/me/favourites/{uuid.uuid4()}", body={}, user_id=o, idem=idem()), 404, "NOT_FOUND")
    assert_error(client.call("PUT", f"/v1/me/favourites/{A}", body={}, user_id=o), 422, "VALIDATION_FAILED")              # no key
    d = assert_ok(client.call("GET", "/v1/me/favourites", user_id=o), 200, "FavouritesResponse")["data"]
    assert [x["listing_id"] for x in d["items"]] == [L_B, A] and d["total"] == 2
    a = d["items"][1]["listing"]
    assert a["title"] == "Chambre meublée centre wifi" and a["photo_count"] == 2 and a["cover_photo"]["url"]
    page = assert_ok(client.call("GET", "/v1/me/favourites", user_id=o, params={"limit": "1"}), 200, "FavouritesResponse")["data"]
    assert len(page["items"]) == 1 and page["next_before"]
    rest = assert_ok(client.call("GET", "/v1/me/favourites", user_id=o, params={"limit": "1", "before": str(page["next_before"])}),
                     200, "FavouritesResponse")["data"]
    assert [x["listing_id"] for x in rest["items"]] == [A]
    # another user's list and removals do not touch these
    d2 = assert_ok(client.call("GET", "/v1/me/favourites", user_id=p2["owner"]), 200, "FavouritesResponse")["data"]
    assert d2["items"] == []
    r = assert_ok(client.call("DELETE", f"/v1/me/favourites/{A}", user_id=p2["owner"], idem=idem()), 200, "FavouriteResponse")
    assert r["data"]["removed"] is False
    assert len(assert_ok(client.call("GET", "/v1/me/favourites", user_id=o), 200, "FavouritesResponse")["data"]["items"]) == 2
    r = assert_ok(client.call("DELETE", f"/v1/me/favourites/{A}", user_id=o, idem=idem()), 200, "FavouriteResponse")
    assert r["data"] == {"listing_id": A, "favourite": False, "removed": True}
    r = assert_ok(client.call("DELETE", f"/v1/me/favourites/{A}", user_id=o, idem=idem()), 200, "FavouriteResponse")
    assert r["data"]["removed"] is False
    assert_error(client.call("GET", "/v1/me/favourites", user_id=p2["no_consent"]), 403, "CONSENT_REQUIRED")


def test_a_favourite_stays_when_the_listing_is_withdrawn(client, p2, idem):
    db, o = p2["db"], p2["other"]
    assert_ok(client.call("PUT", f"/v1/me/favourites/{L_C}", body={}, user_id=o, idem=idem()), 200, "FavouriteResponse")
    db.execute("update app.listings set status = 'archived' where id = %s", (L_C,))
    try:
        items = assert_ok(client.call("GET", "/v1/me/favourites", user_id=o), 200, "FavouritesResponse")["data"]["items"]
        c = next(x for x in items if x["listing_id"] == L_C)
        assert c["available"] is False and c["listing"] is None
        assert_error(client.call("GET", f"/v1/listings/{L_C}/public", user_id=o), 404, "NOT_FOUND")
        r = assert_ok(client.call("DELETE", f"/v1/me/favourites/{L_C}", user_id=o, idem=idem()), 200, "FavouriteResponse")
        assert r["data"]["removed"] is True
    finally:
        db.execute("update app.listings set status = 'published' where id = %s", (L_C,))


# ---------- POST /v1/listing-changes/{id}/cancel ------------------------------------------------------------------------
def proposal(db, user, listing, status="pending", age_min=0):
    return str(db.execute("""insert into ai.listing_changes (user_id, listing_id, changes, diff, status, created_at)
                             values (%s, %s, '{"rent": 420}', '[{"field": "rent", "before": 400, "after": 420}]', %s,
                                     now() - make_interval(mins => %s)) returning id""", (user, listing, status, age_min)).fetchone()[0])


def test_cancel_a_proposal(client, p2, idem):
    db, owner = p2["db"], p2["owner"]
    ch = proposal(db, owner, p2["A"])
    url = f"/v1/listing-changes/{ch}/cancel"
    assert_error(client.call("POST", url, body={}, user_id=p2["other"], idem=idem()), 404, "NOT_FOUND")
    k = idem()
    d = assert_ok(client.call("POST", url, body={}, user_id=owner, idem=k), 200, "ListingChangeCancelResponse")["data"]
    assert d["change_id"] == ch and d["listing_id"] == p2["A"] and d["status"] == "cancelled"
    assert client.call("POST", url, body={}, user_id=owner, idem=k).json()["data"] == d, "replay"
    j = assert_error(client.call("POST", url, body={}, user_id=owner, idem=idem()), 409, "CONFLICT")
    assert j["error"]["details"] == [{"field": "change_id", "issue": "already_cancelled"}]
    assert db.execute("select status from ai.listing_changes where id = %s", (ch,)).fetchone()[0] == "cancelled"
    old = proposal(db, owner, p2["A"], age_min=90)
    j = assert_error(client.call("POST", f"/v1/listing-changes/{old}/cancel", body={}, user_id=owner, idem=idem()), 409, "CONFLICT")
    assert j["error"]["details"][0]["issue"] == "expired"
    done = proposal(db, owner, p2["A"], status="applied")
    j = assert_error(client.call("POST", f"/v1/listing-changes/{done}/cancel", body={}, user_id=owner, idem=idem()), 409, "CONFLICT")
    assert j["error"]["details"][0]["issue"] == "already_applied"
    assert_error(client.call("POST", "/v1/listing-changes/nope/cancel", body={}, user_id=owner, idem=idem()), 404, "NOT_FOUND")
    assert_error(client.call("POST", f"/v1/listing-changes/{uuid.uuid4()}/cancel", body={}, user_id=owner, idem=idem()), 404, "NOT_FOUND")
    fresh = proposal(db, owner, p2["A"])
    assert_error(client.call("POST", f"/v1/listing-changes/{fresh}/cancel", body={"why": 1}, user_id=owner, idem=idem()),
                 422, "VALIDATION_FAILED")
    assert db.execute("select status from ai.listing_changes where id = %s", (fresh,)).fetchone()[0] == "pending"
