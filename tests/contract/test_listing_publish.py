"""D-083: the availability date check on P3 answers, and automatic publication after the analysis (setting
listing.auto_publish, off by default; testing only).

Sandbox only: the model is the Ollama mock. "[mock:date]" makes it answer available_from 2026-11-01 whatever the text
says; "[mock:place=Name]" makes it answer that neighbourhood (tests/mocks/deps_mock.py chat_answer).
"""
import uuid

import pytest

from conftest import assert_ok, sandbox_only
from test_intake_media import owner  # noqa: F401  (module fixture reused)
from test_listing_extract import analyze, view
from test_profile_search import make_user
from test_telegram import consented_chat, push, sent, text_msg, wait_reply

pytestmark = sandbox_only

PLACE = "Autopub Quarter"


@pytest.fixture
def auto_publish(db):
    """Setting on, one test place in QX (API tests) and TN (Telegram's default country); everything undone after."""
    keys = []
    for jur, lng, lat in (("QX", 10.2, 36.2), ("TN", 10.6, 35.8)):
        key = f"test-autopub-{jur.lower()}-{uuid.uuid4().hex[:6]}"
        pid = db.execute("""insert into app.places (place_key, jurisdiction_code, kind, name, city, location, source)
                            values (%s, %s, 'neighbourhood', %s, 'Testville', st_setsrid(st_makepoint(%s, %s), 4326)::geography, 'test')
                            returning id""", (key, jur, PLACE, lng, lat)).fetchone()[0]
        db.execute("insert into app.place_names (place_id, name) values (%s, %s)", (pid, PLACE))
        keys.append(key)
    db.execute("update app.settings set value = 'true' where key = 'listing.auto_publish'")
    yield
    db.execute("update app.settings set value = 'false' where key = 'listing.auto_publish'")
    db.execute("""delete from app.listings where extraction->'publication'->>'mode' = 'auto'""")
    db.execute("delete from app.places where place_key = any(%s)", (keys,))


# ------------------------------------------------------------------ date check

def test_a_date_the_text_does_not_give_is_removed(client, owner, idem):  # noqa: F811
    lid, job = analyze(client, owner["owner"], idem, "Chambre meublée à Testville, 450 DT [mock:date]")
    assert job["status"] == "succeeded", job
    v = view(client, owner["owner"], lid)
    assert v["available_from"] is None and v["extraction"]["model_output"]["available_from"] == "2026-11-01"
    assert "available_from_not_in_text" in v["extraction"]["issues"]
    assert "available_from" in v["extraction"]["checks_changed"]


def test_a_date_the_text_gives_is_kept(client, owner, idem):  # noqa: F811
    lid, job = analyze(client, owner["owner"], idem, "Chambre meublée à Testville, 450 DT, libre le 1er novembre [mock:date]")
    v = view(client, owner["owner"], lid)
    assert v["available_from"] == "2026-11-01" and "available_from_not_in_text" not in v["extraction"]["issues"]


# ------------------------------------------------------------------ automatic publication

def test_auto_publish_is_off_by_default(client, owner, idem, db):  # noqa: F811
    assert db.execute("select value::text from app.settings where key = 'listing.auto_publish'").fetchone()[0] == "false"
    lid, job = analyze(client, owner["owner"], idem, f"Chambre meublée, 450 DT [mock:place={PLACE}]")
    assert job["output"]["publication"] == {"published": False, "reason": "auto_publish_off", "missing": []}
    assert view(client, owner["owner"], lid)["status"] == "draft"


def test_listing_with_rent_and_place_is_published_and_found(client, owner, idem, db, auto_publish):  # noqa: F811
    lid, job = analyze(client, owner["owner"], idem, f"Chambre meublée près de la fac\nS+3, 450 DT, wifi [mock:place={PLACE}]")
    assert job["status"] == "succeeded", job
    assert job["output"]["publication"] == {"published": True, "reason": None, "missing": []}
    v = view(client, owner["owner"], lid)
    assert v["status"] == "published" and v["title"] == "Chambre meublée près de la fac"
    pub = v["extraction"]["publication"]
    assert pub["mode"] == "auto" and pub["published"] is True and pub["checked"] is False and pub["place"] == PLACE
    row = db.execute("""select embedding is not null, embedding_model, public_location is not null,
                               not st_equals(location::geometry, public_location::geometry)
                        from app.listings where id = %s""", (lid,)).fetchone()
    assert row == (True, "bge-m3", True, True)                 # vector stored; only the fuzzed point is public
    assert db.execute("select count(*) from app.audit_log where action = 'listing_auto_published' and entity_id = %s",
                      (lid,)).fetchone()[0] == 1
    uid = make_user(db, "user")
    found = assert_ok(client.call("GET", "/v1/search", user_id=uid, params={"jurisdiction": "QX"}), 200, "SearchResponse")
    assert lid in [x["id"] for x in found["data"]["results"]]


def test_listing_without_a_place_stays_a_draft(client, owner, idem, auto_publish):  # noqa: F811
    lid, job = analyze(client, owner["owner"], idem, "Chambre meublée, 450 DT")
    assert job["output"]["publication"] == {"published": False, "reason": "missing", "missing": ["place"]}
    v = view(client, owner["owner"], lid)
    assert v["status"] == "draft" and v["extraction"]["publication"]["missing"] == ["place"]


def test_telegram_listing_is_published_and_the_bot_says_so(db, auto_publish):
    chat = consented_chat()
    n = len(sent())
    push(text_msg(chat, f"/annonce Chambre meublée à {PLACE}, 350 DT, wifi [mock:place={PLACE}]"))
    p = wait_reply(chat, n, lambda p: "Ce que j'ai lu" in p["text"], timeout=150)
    assert "Publiée" in p["text"]
    n = len(sent())
    push(text_msg(chat, "/annonce Chambre meublée, 350 DT, wifi"))
    p = wait_reply(chat, n, lambda p: "Ce que j'ai lu" in p["text"], timeout=150)
    assert "Pas publiée" in p["text"]
    rows = db.execute("""select l.status from app.listings l join app.users u on u.id = l.owner_id
                         where u.external_auth_id = %s order by l.created_at""", (f"telegram:{chat}",)).fetchall()
    assert [r[0] for r in rows] == ["published", "draft"]
