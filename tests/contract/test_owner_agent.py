"""Owner assistant and PATCH /v1/listings/:id (D-088), in the sandbox.

Sandbox only: the model is the Ollama mock (tests/mocks/deps_mock.py owner_answer): it lists the owner's listings,
then proposes what the message says ("N dt" the rent, "photo N", "loué", "wifi", "quartier X"). These tests check the
wiring, the proposal and its confirmation, the checks in the database and the Telegram buttons, not the model.
Listings are written directly in the test jurisdiction QX (places of test_profile_search: "Testville centre").
"""
import uuid

import pytest

from conftest import assert_error, assert_ok, sandbox_only
from test_profile_search import make_user, qx  # noqa: F401  (module fixture reused)

pytestmark = sandbox_only

RENT = "le loyer de mon annonce passe à 420 dt"


def add_listing(db, owner, status="published", rent=350000, photos=2, jur="QX", place=True):
    lid = str(uuid.uuid4())
    db.execute("""insert into app.listings (id, owner_id, jurisdiction_code, status, title, description, rent_minor, currency,
                                            location, city, neighbourhood, published_at, amenities, source, is_synthetic)
                  values (%s, %s, %s, %s, 'Chambre test', 'Chambre test du propriétaire', %s, 'TND',
                          case when %s then st_setsrid(st_makepoint(10.0, 36.0), 4326)::geography end,
                          case when %s then 'Testville' end, null, case when %s = 'published' then now() end, '{tv}', 'user', true)""",
               (lid, owner, jur, status, rent, place, place, status))
    for i in range(photos):
        db.execute("""insert into app.listing_media (listing_id, kind, storage_key, mime, bytes, sha256, moderation, created_at)
                      values (%s, 'photo', %s, 'image/jpeg', 1, %s, 'ok', now() - make_interval(secs => %s))""",
                   (lid, f"media/test-owner/{lid}/{i + 1}.jpg", uuid.uuid4().hex, 100 - i))
    return lid


@pytest.fixture
def owner(db, qx):  # noqa: F811
    uid = make_user(db, "owner")
    return uid, add_listing(db, uid)


def say(client, uid, text):
    return assert_ok(client.call("POST", "/v1/assistant/message", user_id=uid, body={"text": text}), 200, "AssistantResponse")


def patch(client, uid, lid, body, idem):
    return client.call("PATCH", f"/v1/listings/{lid}", user_id=uid, body=body, idem=idem())


def test_a_change_is_proposed_then_confirmed_once(client, db, owner, idem):
    uid, lid = owner
    j = say(client, uid, RENT)
    d = j["data"]
    assert d["intent"] == "post_listing" and d["status"] == "proposed", d
    assert d["agent"]["tool_calls"] == ["my_listings", "propose_change"]
    p = d["proposal"]
    assert p["listing_id"] == lid and p["listing_number"] == 1 and p["changes"] == {"rent": 420}
    assert p["diff"] == [{"field": "rent", "before": 350, "after": 420, "currency": "TND"}]
    assert db.execute("select rent_minor from app.listings where id = %s", (lid,)).fetchone()[0] == 350000   # not yet
    r = assert_ok(patch(client, uid, lid, {"change_id": p["change_id"]}, idem), 200, "ListingChangeResponse")
    assert r["data"]["diff"] == p["diff"] and r["data"]["status"] == "published"
    assert db.execute("select rent_minor from app.listings where id = %s", (lid,)).fetchone()[0] == 420000
    assert_error(patch(client, uid, lid, {"change_id": p["change_id"]}, idem), 409, "CONFLICT")
    step = db.execute("""select s.output, s.tool_calls from ai.agent_steps s join ai.executions e on e.id = s.execution_id
                         where e.request_id = %s and s.agent = 'A1_owner_agent'""", (j["request_id"],)).fetchone()
    assert step[0]["proposed"] is True and step[0]["fields"] == ["rent"] and "420" not in str(step[1])


def test_a_rent_in_millimes_is_refused_by_the_database(client, owner):
    uid, _ = owner
    d = say(client, uid, "[mock:millimes] " + RENT)["data"]
    assert d["status"] == "answered" and d["proposal"] is None and "out_of_range" in d["answer"], d


def test_removing_a_photo(client, db, owner, idem):
    uid, lid = owner
    p = say(client, uid, "enlève la photo 2 de mon annonce")["data"]["proposal"]
    assert p["diff"] == [{"field": "remove_photos", "before": None, "after": [2]}]
    r = assert_ok(patch(client, uid, lid, {"change_id": p["change_id"]}, idem), 200, "ListingChangeResponse")
    keys = [k for (k,) in db.execute("select storage_key from app.listing_media where listing_id = %s", (lid,)).fetchall()]
    assert keys == [f"media/test-owner/{lid}/1.jpg"] and r["data"]["photos_deleted_from_storage"] == 1


def test_a_follow_up_changes_the_same_listing(client, owner):
    uid, lid = owner
    say(client, uid, RENT)
    d = say(client, uid, "et ajoute le wifi")["data"]           # the mock P1 reads it as smalltalk: a follow-up
    assert d["status"] == "proposed" and "followup" in d["warnings"], d
    assert d["proposal"]["listing_id"] == lid and d["proposal"]["changes"] == {"amenities_add": ["wifi"]}


def test_a_user_without_listings_gets_the_hint(client, db, qx):  # noqa: F811
    uid = make_user(db, "user")
    d = say(client, uid, RENT)["data"]
    assert d["intent"] == "post_listing" and d["status"] == "not_available_yet", d


def test_patch_fields_directly(client, db, owner, idem):
    uid, lid = owner
    r = assert_ok(patch(client, uid, lid, {"place": "Testville centre", "furnished": True, "house_rules": {"smoking": "no"}}, idem),
                  200, "ListingChangeResponse")
    assert [x["field"] for x in r["data"]["diff"]] == ["place", "furnished", "house_rules"] and r["data"]["embedded"] is True
    row = db.execute("select neighbourhood, furnished, house_rules, embedding is not null from app.listings where id = %s", (lid,)).fetchone()
    assert row == ("Testville centre", True, {"smoking": "no"}, True)
    e = assert_error(patch(client, uid, lid, {"rent": "abc", "colour": "red"}, idem), 422, "VALIDATION_FAILED")
    assert {(x["field"], x["issue"]) for x in e["error"]["details"]} == {("rent", "invalid_number"), ("colour", "unknown_field")}
    other = make_user(db, "owner")
    assert_error(patch(client, other, lid, {"rent": 400}, idem), 404, "NOT_FOUND")       # another owner's listing
    assert_error(patch(client, uid, lid, {"change_id": "x"}, idem), 422, "VALIDATION_FAILED")


def test_a_draft_is_published_once_its_rent_is_given(client, db, qx, idem):  # noqa: F811
    uid = make_user(db, "owner")
    lid = add_listing(db, uid, status="draft", rent=None, photos=0)
    db.execute("update app.listings set neighbourhood = 'Testville centre' where id = %s", (lid,))
    db.execute("update app.settings set value = 'true' where key = 'listing.auto_publish'")
    try:
        r = assert_ok(patch(client, uid, lid, {"rent": 380}, idem), 200, "ListingChangeResponse")
    finally:
        db.execute("update app.settings set value = 'false' where key = 'listing.auto_publish'")
    assert r["data"]["status"] == "published" and r["data"]["publication"]["published"] is True and r["data"]["embedded"] is True


def test_rented_archives_it(client, db, owner, idem):
    uid, lid = owner
    p = say(client, uid, "mon annonce est louée")["data"]["proposal"]
    assert p["diff"] == [{"field": "status", "before": "published", "after": "archived"}]
    assert_ok(patch(client, uid, lid, {"change_id": p["change_id"]}, idem), 200, "ListingChangeResponse")
    assert db.execute("select status from app.listings where id = %s", (lid,)).fetchone()[0] == "archived"


# --- Telegram: the proposal with two buttons; confirm writes, cancel does not --------------------------------------

def tg_owner(db):
    from test_telegram import consented_chat
    chat = consented_chat()
    uid = db.execute("select id::text from app.users where external_auth_id = %s", (f"telegram:{chat}",)).fetchone()[0]
    return chat, uid, add_listing(db, uid, jur="TN")


def test_telegram_confirm_button(db, qx):  # noqa: F811
    from test_telegram import button, push, sent, text_msg, wait_reply
    chat, uid, lid = tg_owner(db)
    n = len(sent())
    push(text_msg(chat, RENT))
    p = wait_reply(chat, n, lambda p: "Modification proposée" in p.get("text", ""), timeout=90)
    assert "Loyer : 350 DT → 420 DT" in p["text"], p["text"]
    row = p["reply_markup"]["inline_keyboard"][0]
    assert [b["text"] for b in row] == ["✅ Confirmer", "✖ Annuler"] and row[0]["callback_data"].startswith("lc:")
    n = len(sent())
    push(button(chat, row[0]["callback_data"]))
    done = wait_reply(chat, n, lambda p: "Annonce modifiée" in p.get("text", ""), timeout=60)
    assert "Loyer : 350 DT → 420 DT" in done["text"]
    assert db.execute("select rent_minor from app.listings where id = %s", (lid,)).fetchone()[0] == 420000
    n = len(sent())
    push(button(chat, row[0]["callback_data"]))                  # pressed again: no longer valid
    wait_reply(chat, n, lambda p: "plus valable" in p.get("text", ""), timeout=60)


def test_telegram_cancel_button(db, qx):  # noqa: F811
    from test_telegram import button, push, sent, text_msg, wait_reply
    chat, uid, lid = tg_owner(db)
    n = len(sent())
    push(text_msg(chat, RENT))
    p = wait_reply(chat, n, lambda p: "Modification proposée" in p.get("text", ""), timeout=90)
    n = len(sent())
    push(button(chat, p["reply_markup"]["inline_keyboard"][0][1]["callback_data"]))
    wait_reply(chat, n, lambda p: "annulée" in p.get("text", ""), timeout=60)
    assert db.execute("select rent_minor from app.listings where id = %s", (lid,)).fetchone()[0] == 350000


def test_a_message_about_my_listing_goes_to_the_owner_assistant(client, owner):
    uid, _ = owner
    # the mock P1 reads "caution" as a legal question; "mon annonce" from a user with listings wins (D-089)
    d = say(client, uid, "la caution de mon annonce est 700 dt")["data"]
    assert d["intent"] == "post_listing" and "own_listing" in d["warnings"] and d["status"] == "proposed", d
