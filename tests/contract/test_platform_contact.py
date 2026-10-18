"""Platform P4 (docs/PLATFORM_SPEC.md 3.4, 9 P4; D-103): messages, blocks, visit slots and visits, applications, reports.

A seeker writes to an owner about a published listing, they agree a visit in one of the owner's slots, the seeker
applies and the owner accepts; each step notifies the other side. Every operation of a conversation, visit or
application is also tried by a third user in test_isolation.py. Test jurisdiction QV.
"""
import os
import uuid
from datetime import datetime, timedelta, timezone

import psycopg
import pytest

from conftest import assert_error, assert_ok
from test_profile_search import make_user

CONSENTS = ("terms", "privacy")
LISTING = "00000000-0000-4000-8000-0000000004a1"
DRAFT = "00000000-0000-4000-8000-0000000004a2"


def idem():
    return "t-" + uuid.uuid4().hex


def iso(dt):
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


@pytest.fixture(scope="module")
def p4(client):
    db = psycopg.connect(os.environ["FS_TEST_DB_DSN"], autocommit=True)
    db.execute("""insert into app.jurisdictions (code, country_code, name, default_currency, default_locale, languages, timezone)
                  values ('QV', 'QV', 'Test jurisdiction P4 (tests only)', 'TND', 'fr-TN', '{fr,ar}', 'Africa/Tunis')
                  on conflict (code) do nothing""")
    db.execute("delete from app.listings where jurisdiction_code = 'QV'")
    u = {k: make_user(db, "user", CONSENTS, jurisdiction="QV") for k in ("seeker", "owner", "third")}
    u["no_consent"] = make_user(db, "user", (), jurisdiction="QV")
    db.execute("update app.users set display_name = 'Olfa' where id = %s", (u["owner"],))
    db.execute("""insert into app.profiles (user_id, jurisdiction_code, declared_preferences, languages, budget_max_minor, currency, budget_period)
                  values (%s, 'QV', '{"smoking": "no", "pets": "yes"}', '{fr,ar}', 450000, 'TND', 'month')""", (u["seeker"],))
    for lid, status in ((LISTING, "published"), (DRAFT, "draft")):
        db.execute("""insert into app.listings (id, owner_id, jurisdiction_code, status, title, description, rent_minor, currency,
                                                published_at, is_synthetic, source)
                      values (%s, %s, 'QV', %s, 'Chambre QV', 'x', 400000, 'TND', case when %s = 'published' then now() end, true, 'synthetic')""",
                   (lid, u["owner"], status, status))
    yield {"db": db, **u, "state": {}}
    db.execute("delete from app.rate_counters where bucket like 'ip:%'")
    db.close()


def call(client, method, path, uid, body=None, params=None):
    return client.call(method, path, user_id=uid, body=body, params=params,
                       idem=idem() if method in ("POST", "PUT", "PATCH", "DELETE") else None)


def notes(client, uid, kind):
    j = assert_ok(client.call("GET", "/v1/me/notifications", user_id=uid), 200)["data"]
    return [x for x in j["items"] if x["type"] == kind]


# ---------- access and validation --------------------------------------------------------------------------------------
def test_signature_user_and_consent(client, p4):
    assert_error(client.call("GET", "/v1/conversations"), 401, "UNAUTHENTICATED")
    url, h, b = client.build("POST", "/v1/conversations", body={"listing_id": LISTING, "text": "x"}, user_id=p4["seeker"], idem=idem())
    h["X-User-Id"] = p4["third"]
    assert_error(client.send("POST", url, h, b), 401, "UNAUTHENTICATED")
    for method, path in (("GET", "/v1/conversations"), ("GET", "/v1/me/visits"), ("GET", "/v1/me/applications"),
                         ("GET", "/v1/owner/applications"), ("GET", "/v1/me/blocks")):
        assert_error(client.call(method, path, user_id=p4["no_consent"]), 403, "CONSENT_REQUIRED")


def test_validation(client, p4):
    s = p4["seeker"]
    j = assert_error(call(client, "POST", "/v1/conversations", s, {"listing_id": "x", "text": "", "foo": 1}), 422, "VALIDATION_FAILED")
    assert {d["field"] for d in j["error"]["details"]} >= {"listing_id", "text", "foo"}
    j = assert_error(call(client, "POST", "/v1/reports", s, {"target_type": "car", "target_id": LISTING, "reason": "x"}), 422, "VALIDATION_FAILED")
    assert {d["field"] for d in j["error"]["details"]} == {"target_type", "reason"}
    assert_error(client.call("POST", "/v1/visits", user_id=s, body={"slot_id": str(uuid.uuid4())}), 422, "VALIDATION_FAILED")   # no key
    assert_error(call(client, "GET", "/v1/me/visits", s, params={"role": "boss"}), 422, "VALIDATION_FAILED")


# ---------- the journey ------------------------------------------------------------------------------------------------
def test_seeker_writes_to_the_owner(client, p4):
    s, o, st = p4["seeker"], p4["owner"], p4["state"]
    assert_error(call(client, "POST", "/v1/conversations", s, {"listing_id": DRAFT, "text": "x"}), 404, "NOT_FOUND")
    j = assert_error(call(client, "POST", "/v1/conversations", o, {"listing_id": LISTING, "text": "x"}), 422, "VALIDATION_FAILED")
    assert j["error"]["details"] == [{"field": "listing_id", "issue": "own_listing"}]
    key = idem()
    first = client.call("POST", "/v1/conversations", user_id=s, body={"listing_id": LISTING, "text": "Bonjour, la chambre est libre ?"}, idem=key)
    d = assert_ok(first, 201, "ConversationStartResponse")["data"]
    st["conv"] = d["conversation"]["conversation_id"]
    assert d["conversation"]["other"]["display_name"] == "Olfa" and d["conversation"]["listing"]["listing_id"] == LISTING
    again = client.call("POST", "/v1/conversations", user_id=s, body={"listing_id": LISTING, "text": "Bonjour, la chambre est libre ?"}, idem=key)
    assert again.json() == first.json(), "same key: the stored answer, no second message"
    assert_error(client.call("POST", "/v1/conversations", user_id=s, body={"listing_id": LISTING, "text": "autre"}, idem=key), 409, "CONFLICT")
    lst = assert_ok(call(client, "GET", "/v1/conversations", o), 200, "ConversationsResponse")["data"]
    assert [c["conversation_id"] for c in lst["items"]] == [st["conv"]] and lst["items"][0]["unread"] == 1
    m = assert_ok(call(client, "POST", f"/v1/conversations/{st['conv']}/messages", o, {"text": "Oui, venez la voir."}), 201, "MessageResponse")
    assert m["data"]["mine"] is True
    msgs = assert_ok(call(client, "GET", f"/v1/conversations/{st['conv']}/messages", s), 200, "MessagesResponse")["data"]
    assert [x["body"] for x in msgs["items"]] == ["Oui, venez la voir.", "Bonjour, la chambre est libre ?"]
    assert msgs["conversation"]["unread"] == 1
    assert assert_ok(call(client, "POST", f"/v1/conversations/{st['conv']}/read", s, {}), 200, "ConversationReadResponse")["data"]["unread"] == 0
    assert len(notes(client, o, "message_received")) == 1 and len(notes(client, s, "message_received")) == 1


def test_visit_in_a_slot(client, p4):
    s, o, st = p4["seeker"], p4["owner"], p4["state"]
    t0 = datetime.now(timezone.utc) + timedelta(days=3)
    slots = [{"starts_at": iso(t0), "ends_at": iso(t0 + timedelta(hours=1)), "capacity": 1},
             {"starts_at": iso(t0 + timedelta(days=1)), "ends_at": iso(t0 + timedelta(days=1, hours=1)), "capacity": 2}]
    assert_error(call(client, "PUT", f"/v1/listings/{LISTING}/visit-slots", s, {"slots": slots}), 404, "NOT_FOUND")
    j = assert_error(call(client, "PUT", f"/v1/listings/{LISTING}/visit-slots", o,
                          {"slots": [{"starts_at": iso(t0), "ends_at": iso(t0 - timedelta(hours=1))}]}), 422, "VALIDATION_FAILED")
    assert j["error"]["details"] == [{"field": "slots[0]", "issue": "invalid_time"}]
    d = assert_ok(call(client, "PUT", f"/v1/listings/{LISTING}/visit-slots", o, {"slots": slots}), 200, "VisitSlotsResponse")["data"]
    assert [x["capacity"] for x in d["items"]] == [1, 2] and d["mine"] is True
    seen = assert_ok(call(client, "GET", f"/v1/listings/{LISTING}/visit-slots", s), 200, "VisitSlotsResponse")["data"]
    assert seen["mine"] is False and [x["free"] for x in seen["items"]] == [1, 2]
    assert_error(call(client, "GET", f"/v1/listings/{DRAFT}/visit-slots", s), 404, "NOT_FOUND")
    slot = seen["items"][0]["slot_id"]
    v = assert_ok(call(client, "POST", "/v1/visits", s, {"slot_id": slot, "note": "Après 18 h si possible"}), 201, "VisitResponse")["data"]
    st["visit"] = v["visit_id"]
    assert v["status"] == "requested" and v["role"] == "seeker" and v["waiting_for"] == "other"
    j = assert_error(call(client, "POST", "/v1/visits", p4["third"], {"slot_id": slot}), 409, "CONFLICT")
    assert j["error"]["details"] == [{"field": "slot_id", "issue": "slot_full"}]
    assert_error(call(client, "POST", f"/v1/visits/{st['visit']}/decision", s, {"action": "confirm"}), 409, "CONFLICT")
    new_time = iso(t0 + timedelta(hours=3))
    p = assert_ok(call(client, "POST", f"/v1/visits/{st['visit']}/decision", o, {"action": "propose", "starts_at": new_time}), 200, "VisitResponse")["data"]
    assert p["status"] == "proposed" and p["waiting_for"] == "other"
    c = assert_ok(call(client, "POST", f"/v1/visits/{st['visit']}/decision", s, {"action": "confirm"}), 200, "VisitResponse")["data"]
    assert c["status"] == "confirmed" and c["starts_at"].startswith(new_time[:16].replace("T", "T"))
    mine = assert_ok(call(client, "GET", "/v1/me/visits", o, params={"role": "owner"}), 200, "VisitsResponse")["data"]["items"]
    assert [x["visit_id"] for x in mine] == [st["visit"]] and mine[0]["actions"]["done"] is False
    assert len(notes(client, o, "visit_requested")) == 1 and len(notes(client, s, "visit_proposed")) == 1
    assert len(notes(client, o, "visit_confirmed")) == 1


def test_application_accepted(client, p4):
    s, o, st = p4["seeker"], p4["owner"], p4["state"]
    a = assert_ok(call(client, "POST", f"/v1/listings/{LISTING}/applications", s,
                       {"message": "Étudiant en master, calme.", "move_in_from": "2026-12-01", "share_profile": True}), 201, "ApplicationResponse")["data"]
    st["app"] = a["application_id"]
    assert a["status"] == "submitted" and a["actions"] == {"accept": False, "decline": False, "withdraw": True}
    j = assert_error(call(client, "POST", f"/v1/listings/{LISTING}/applications", s, {}), 409, "CONFLICT")
    assert j["error"]["details"] == [{"field": "listing_id", "issue": "already_applied"}]
    seen = assert_ok(call(client, "GET", "/v1/owner/applications", o), 200, "ApplicationsResponse")["data"]["items"]
    assert seen[0]["shared_profile"]["declared_preferences"] == {"smoking": "no", "pets": "yes"}
    assert set(seen[0]["shared_profile"]) <= {"declared_preferences", "languages", "move_in_from", "min_stay_months", "budget"}
    assert_error(call(client, "POST", f"/v1/applications/{st['app']}/decision", s, {"action": "accept"}), 403, "FORBIDDEN")
    assert_error(call(client, "POST", f"/v1/applications/{st['app']}/withdraw", o, {}), 403, "FORBIDDEN")
    d = assert_ok(call(client, "POST", f"/v1/applications/{st['app']}/decision", o, {"action": "accept"}), 200, "ApplicationResponse")["data"]
    assert d["status"] == "accepted"
    assert_error(call(client, "POST", f"/v1/applications/{st['app']}/decision", o, {"action": "decline"}), 409, "CONFLICT")
    mine = assert_ok(call(client, "GET", "/v1/me/applications", s), 200, "ApplicationsResponse")["data"]["items"]
    assert mine[0]["status"] == "accepted" and mine[0]["role"] == "applicant"
    assert len(notes(client, o, "application_received")) == 1 and len(notes(client, s, "application_accepted")) == 1


def test_report(client, p4):
    t = p4["third"]
    r = assert_ok(call(client, "POST", "/v1/reports", t, {"target_type": "listing", "target_id": LISTING, "reason": "scam", "detail": "Demande un virement"}),
                  201, "ReportResponse")
    assert r["data"]["status"] == "open"
    assert_error(call(client, "POST", "/v1/reports", t, {"target_type": "listing", "target_id": DRAFT, "reason": "scam"}), 404, "NOT_FOUND")
    assert_error(call(client, "POST", "/v1/reports", t, {"target_type": "user", "target_id": p4["owner"], "reason": "spam"}), 404, "NOT_FOUND")
    msg = assert_ok(call(client, "GET", f"/v1/conversations/{p4['state']['conv']}/messages", p4["seeker"]), 200)["data"]["items"][0]["id"]
    assert_error(call(client, "POST", "/v1/reports", t, {"target_type": "message", "target_id": str(msg), "reason": "spam"}), 404, "NOT_FOUND")
    assert_ok(call(client, "POST", "/v1/reports", p4["seeker"], {"target_type": "message", "target_id": str(msg), "reason": "offensive"}), 201)
    row = p4["db"].execute("select target_type, status, target_user_id::text from app.reports where message_id = %s", (msg,)).fetchone()
    assert row == ("message", "open", p4["owner"])


def test_message_limit(client, p4):
    db, o, conv = p4["db"], p4["owner"], p4["state"]["conv"]
    assert_ok(call(client, "POST", f"/v1/conversations/{conv}/messages", o, {"text": "Une précision"}), 201)
    db.execute("update app.settings set value = '1' where key = 'messages.per_minute'")
    try:
        j = assert_error(call(client, "POST", f"/v1/conversations/{conv}/messages", o, {"text": "encore"}), 429, "RATE_LIMITED")
        assert j["error"]["details"][0]["retry_after_s"] == 60
    finally:
        db.execute("update app.settings set value = '20' where key = 'messages.per_minute'")


def test_block_stops_everything(client, p4):
    s, o, st = p4["seeker"], p4["owner"], p4["state"]
    assert_error(call(client, "POST", "/v1/me/blocks", o, {"user_id": p4["third"]}), 404, "NOT_FOUND")     # no link between them
    b = assert_ok(call(client, "POST", "/v1/me/blocks", o, {"user_id": s}), 200, "BlockResponse")["data"]
    assert b == {"user_id": s, "blocked": True}
    for who in (s, o):
        j = assert_error(call(client, "POST", f"/v1/conversations/{st['conv']}/messages", who, {"text": "?"}), 409, "CONFLICT")
        assert j["error"]["details"] == [{"issue": "blocked"}]
    assert_error(call(client, "POST", "/v1/conversations", s, {"listing_id": LISTING, "text": "?"}), 409, "CONFLICT")
    assert_error(call(client, "POST", f"/v1/listings/{LISTING}/applications", s, {}), 409, "CONFLICT")
    v = assert_ok(call(client, "GET", "/v1/me/visits", s), 200)["data"]["items"]
    assert v[0]["status"] == "cancelled", "the confirmed visit ends with the block"
    assert assert_ok(call(client, "GET", "/v1/me/blocks", o), 200, "BlocksResponse")["data"]["items"][0]["user_id"] == s
    assert assert_ok(call(client, "GET", "/v1/conversations", s), 200)["data"]["items"][0]["blocked"] is True
    assert assert_ok(call(client, "DELETE", f"/v1/me/blocks/{s}", o), 200, "BlockResponse")["data"]["blocked"] is False
    assert_ok(call(client, "POST", f"/v1/conversations/{st['conv']}/messages", s, {"text": "Merci"}), 201)
