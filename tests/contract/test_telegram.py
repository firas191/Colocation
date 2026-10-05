"""Telegram channel (D-079), end to end in the sandbox: mock Telegram API -> long-polling relay -> wf.channel.telegram
-> the public API (signed as the internal 'telegram' client) -> reply through the mock. The model is the Ollama mock,
so these tests check the channel's plumbing, consent rules and replies, not the quality of the answers.

Sandbox only: needs the mock Telegram (tests/mocks/deps_mock.py telegram 8098) and the relay running against it.
"""
import hashlib
import io
import os
import random
import time

import httpx
import psycopg
import pytest
from PIL import Image

from conftest import sandbox_only

TG = os.environ.get("FS_MOCK_TELEGRAM", "http://127.0.0.1:8098")
pytestmark = sandbox_only


def push(update: dict) -> int:
    return httpx.post(f"{TG}/_mock/telegram/updates", json=update, timeout=10).json()["update_id"]


def sent(since: int = 0) -> list:
    return httpx.get(f"{TG}/_mock/telegram/sent", params={"since": since}, timeout=10).json()


MOCK_BOT = hashlib.sha256(b"mock-token").hexdigest()[:16]     # what the relay sends for the lab's token (poller.bot_key)
N8N_TG = os.environ.get("FS_N8N_TELEGRAM_URL", "http://127.0.0.1:5678/webhook/telegram/update")


def text_msg(chat: int, text: str, lang: str = "fr") -> dict:
    return {"message": {"message_id": random.randint(1, 10**6), "date": int(time.time()), "chat": {"id": chat, "type": "private"},
                        "from": {"id": chat, "language_code": lang, "first_name": "T"}, "text": text}}


def button(chat: int, data: str) -> dict:
    return {"callback_query": {"id": f"cb{random.randint(1, 10**9)}", "from": {"id": chat, "language_code": "fr"}, "data": data,
                               "message": {"message_id": 1, "chat": {"id": chat, "type": "private"}}}}


def wait_reply(chat: int, since: int, pred=lambda m: True, timeout: float = 60, method: str = "sendMessage") -> dict:
    deadline = time.time() + timeout
    while time.time() < deadline:
        for m in sent(since):
            p = m["params"]
            if m["method"] == method and str(p.get("chat_id")) == str(chat) and pred(p):
                return p
        time.sleep(0.5)
    raise AssertionError(f"no {method} to {chat} matching within {timeout} s; sent: {[x for x in sent(since) if str(x['params'].get('chat_id')) == str(chat)]}")


@pytest.fixture
def db():
    c = psycopg.connect(os.environ["FS_TEST_DB_DSN"], autocommit=True)
    yield c
    c.close()


def new_chat() -> int:
    return random.randint(10**8, 10**9)


def consented_chat(lang: str = "fr") -> int:
    chat = new_chat()
    n = len(sent())
    push(text_msg(chat, "/start", lang))
    wait_reply(chat, n, lambda p: "reply_markup" in p)
    n = len(sent())
    push(button(chat, "consent:yes"))
    wait_reply(chat, n, lambda p: "/stop" in p["text"])
    return chat


def test_nothing_is_processed_before_consent(db):
    chat = new_chat()
    n = len(sent())
    push(text_msg(chat, "cherche chambre près de l'ENIT, 400 dt"))
    p = wait_reply(chat, n)
    buttons = [b["callback_data"] for b in p["reply_markup"]["inline_keyboard"][0]]
    assert buttons == ["consent:yes", "consent:no"] and "Telegram" in p["text"]
    assert db.execute("select count(*) from app.users where external_auth_id = %s", (f"telegram:{chat}",)).fetchone()[0] == 0
    n = len(sent())
    push(button(chat, "consent:no"))
    wait_reply(chat, n, lambda p: "/start" in p["text"])
    assert any(m["method"] == "answerCallbackQuery" for m in sent(n))       # the button's spinner is stopped
    assert db.execute("select count(*) from app.users where external_auth_id = %s", (f"telegram:{chat}",)).fetchone()[0] == 0


def test_consent_creates_the_user_through_the_api(db):
    chat = consented_chat()
    rows = db.execute("""select c.purpose, c.granted, c.source, c.policy_version from app.users u join app.consents c on c.user_id = u.id
                         where u.external_auth_id = %s order by c.purpose""", (f"telegram:{chat}",)).fetchall()
    assert [(r[0], r[1], r[2]) for r in rows] == [("media_processing", True, "telegram"), ("privacy", True, "telegram"), ("terms", True, "telegram")]
    keys = {r[0] for r in db.execute("""select distinct e.workflow from ai.executions e join app.users u on u.id = e.user_id
                                        where u.external_auth_id = %s""", (f"telegram:{chat}",))}
    assert "wf.api.me_consents" in keys                                   # the bot used the public API, like any client


def test_search_message_goes_through_the_assistant(db):
    chat = consented_chat()
    n = len(sent())
    push(text_msg(chat, "cherche chambre meublée à Ennasr, 450 dt max, non fumeur"))
    p = wait_reply(chat, n, lambda p: "annonce" in p["text"].lower() or "budget" in p["text"].lower(), timeout=90)
    assert "450" in p["text"] and p["parse_mode"] == "HTML"
    wait_reply(chat, n, method="sendChatAction")
    row = db.execute("""select e.channel, e.status from ai.executions e join app.users u on u.id = e.user_id
                        where u.external_auth_id = %s and e.workflow = 'wf.orchestrator'""", (f"telegram:{chat}",)).fetchone()
    assert row == ("api", "succeeded")


def test_commands_country_me_and_unknown(db):
    chat = consented_chat()
    n = len(sent())
    push(text_msg(chat, "/pays FR"))
    wait_reply(chat, n, lambda p: "FR" in p["text"])
    assert db.execute("select jurisdiction_code from app.users where external_auth_id = %s", (f"telegram:{chat}",)).fetchone()[0] == "FR"
    n = len(sent())
    push(text_msg(chat, "/pays XX"))
    wait_reply(chat, n, lambda p: "/pays TN" in p["text"])
    n = len(sent())
    push(text_msg(chat, "/moi"))
    wait_reply(chat, n, lambda p: str(chat) in p["text"] and "FR" in p["text"])
    n = len(sent())
    push(text_msg(chat, "/trace"))
    wait_reply(chat, n, lambda p: "administrateurs" in p["text"])


def test_voice_note_gets_a_plain_answer():
    chat = consented_chat("en")
    n = len(sent())
    u = text_msg(chat, "", "en")
    del u["message"]["text"]
    u["message"]["voice"] = {"file_id": "v1", "duration": 3}
    push(u)
    wait_reply(chat, n, lambda p: "Voice notes" in p["text"])


def test_admin_trace_of_the_last_request(db):
    chat = consented_chat()
    db.execute("update app.users set role = 'admin' where external_auth_id = %s", (f"telegram:{chat}",))
    n = len(sent())
    push(text_msg(chat, "cherche chambre à Sousse, 300 dt"))
    wait_reply(chat, n, lambda p: "300" in p["text"], timeout=90)
    n = len(sent())
    push(text_msg(chat, "/trace"))
    p = wait_reply(chat, n, lambda p: "Trace" in p["text"])
    assert "wf.orchestrator" in p["text"] and "A0_orchestrator" in p["text"] and "P1_router v" in p["text"]


def test_listing_with_photo_is_extracted_and_the_photo_processed(db):
    chat = consented_chat()
    img = Image.new("RGB", (800, 600), (120, 160, 200))
    b = io.BytesIO()
    img.save(b, "JPEG", quality=85)
    fid = f"ph{random.randint(1, 10**9)}"
    httpx.post(f"{TG}/_mock/telegram/files/{fid}", content=b.getvalue(), timeout=10)
    n = len(sent())
    u = text_msg(chat, "")
    del u["message"]["text"]
    u["message"]["photo"] = [{"file_id": "small", "width": 90, "height": 60}, {"file_id": fid, "width": 800, "height": 600}]
    u["message"]["caption"] = "/annonce Chambre meublée dans un S+2 à Sahloul, 350.000 DT CC, wifi, non fumeur"
    push(u)
    wait_reply(chat, n, lambda p: "analyse en cours" in p["text"].lower(), timeout=60)
    p = wait_reply(chat, n, lambda p: "Ce que j'ai lu" in p["text"], timeout=150)
    assert "350 DT/mois" in p["text"] and "charges comprises" in p["text"] and "meublé" in p["text"]
    assert "Photos" in p["text"] and "1 acceptée" in p["text"]
    row = db.execute("""select l.rent_minor, (select count(*) from app.listing_media m where m.listing_id = l.id)
                        from app.listings l join app.users u on u.id = l.owner_id where u.external_auth_id = %s""",
                     (f"telegram:{chat}",)).fetchone()
    assert row == (350000, 1)


def test_listing_command_needs_text():
    chat = consented_chat()
    n = len(sent())
    push(text_msg(chat, "/annonce"))
    wait_reply(chat, n, lambda p: "/annonce Chambre" in p["text"])


def test_withdrawal_stops_processing(db):
    chat = consented_chat()
    n = len(sent())
    push(text_msg(chat, "/stop"))
    wait_reply(chat, n, lambda p: "retiré" in p["text"])
    n = len(sent())
    push(text_msg(chat, "cherche chambre"))
    wait_reply(chat, n, lambda p: "reply_markup" in p)                      # consent asked again, nothing processed
    granted = db.execute("""select distinct on (purpose) purpose, granted from app.consents c join app.users u on u.id = c.user_id
                            where u.external_auth_id = %s order by purpose, granted_at desc, c.id desc""", (f"telegram:{chat}",)).fetchall()
    assert all(g is False for _, g in granted)


def test_same_update_twice_is_handled_once():
    chat = consented_chat()
    upd = text_msg(chat, "/moi")
    n = len(sent())
    uid = push(upd)
    wait_reply(chat, n, lambda p: str(chat) in p["text"])
    # the relay may hand an update over again after a restart: same update_id, straight to the webhook
    token = os.environ["INTERNAL_SERVICE_TOKEN"]
    r = httpx.post(N8N_TG, json={"update_id": uid, **upd}, headers={"X-Internal-Token": token, "X-Telegram-Bot": MOCK_BOT}, timeout=10)
    assert r.status_code == 200
    time.sleep(4)
    assert len([m for m in sent(n) if str(m["params"].get("chat_id")) == str(chat) and m["method"] == "sendMessage"]) == 1


def test_same_update_id_from_another_bot_is_handled():
    """F-060: a new bot's update ids can overlap with the old bot's; ids are kept per bot."""
    chat = consented_chat()
    upd = text_msg(chat, "/moi")
    n = len(sent())
    uid = push(upd)
    wait_reply(chat, n, lambda p: str(chat) in p["text"])
    n = len(sent())
    other = hashlib.sha256(b"another-bot").hexdigest()[:16]
    r = httpx.post(N8N_TG, json={"update_id": uid, **upd},
                   headers={"X-Internal-Token": os.environ["INTERNAL_SERVICE_TOKEN"], "X-Telegram-Bot": other}, timeout=10)
    assert r.status_code == 200
    wait_reply(chat, n, lambda p: str(chat) in p["text"], timeout=30)


def test_internal_webhook_needs_the_token():
    r = httpx.post(N8N_TG, json={"update_id": 1}, headers={"X-Internal-Token": "wrong", "X-Telegram-Bot": MOCK_BOT}, timeout=10)
    assert r.status_code in (401, 403)
    r = httpx.post(os.environ.get("FS_API_BASE", "http://127.0.0.1:8080") + "/webhook/telegram/update", json={"update_id": 1}, timeout=10)
    assert r.status_code == 404                                               # not reachable through the proxy
