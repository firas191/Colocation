"""D-086: Telegram albums for /annonce, photo cards under search results, and all the photos of a listing as one album.

Sandbox only: mock Telegram API (it records uploads), the relay with its album sender, the Media service, the Ollama
mock ("[mock:place=Name]" makes the listing extractor answer that neighbourhood).
"""
import io
import random
import time

import httpx
from PIL import Image, ImageDraw

from conftest import sandbox_only
from test_listing_publish import PLACE, auto_publish  # noqa: F401  (fixture reused: setting on, test place in TN)
from test_telegram import TG, button, consented_chat, db, push, sent, text_msg, wait_reply  # noqa: F401

pytestmark = sandbox_only


def photo_bytes(colour):
    img = Image.new("RGB", (900, 700), colour)
    d = ImageDraw.Draw(img)
    for i in range(0, 900, 60):
        d.line((i, 0, 900 - i, 700), fill=(255 - colour[0], 255 - colour[1], 255 - colour[2]), width=6)
    b = io.BytesIO()
    img.save(b, "JPEG", quality=85)
    return b.getvalue()


def album(chat, caption, colours):
    """Pushes one Telegram album: one update per photo, same media_group_id, the caption on the first only."""
    group = str(random.randint(10**12, 10**13))
    for i, colour in enumerate(colours):
        fid = f"al{random.randint(1, 10**9)}"
        httpx.post(f"{TG}/_mock/telegram/files/{fid}", content=photo_bytes(colour), timeout=10)
        u = text_msg(chat, "")
        del u["message"]["text"]
        u["message"]["photo"] = [{"file_id": "small", "width": 90, "height": 70}, {"file_id": fid, "width": 900, "height": 700}]
        u["message"]["media_group_id"] = group
        if i == 0 and caption:
            u["message"]["caption"] = caption
        push(u)
    return group


def owner_listing(db, chat):  # noqa: F811
    return db.execute("""select l.id::text, l.status, (select count(*) from app.listing_media m where m.listing_id = l.id)
                         from app.listings l join app.users u on u.id = l.owner_id
                         where u.external_auth_id = %s order by l.created_at desc limit 1""", (f"telegram:{chat}",)).fetchone()


def test_album_photos_all_go_to_the_listing(db):  # noqa: F811
    chat = consented_chat()
    n = len(sent())
    album(chat, "/annonce Chambre meublée, 350 DT, wifi", [(200, 60, 60), (60, 200, 60), (60, 60, 200)])
    p = wait_reply(chat, n, lambda p: "Ce que j'ai lu" in p["text"], timeout=150)
    assert "3 acceptée" in p["text"], p["text"]
    lid, status, photos = owner_listing(db, chat)
    assert photos == 3
    texts = [m["params"].get("text", "") for m in sent(n) if str(m["params"].get("chat_id")) == str(chat)]
    assert not any("légende de la photo" in t for t in texts)              # no "how to post" for the other photos


def test_album_without_the_command_gets_one_hint(db):  # noqa: F811
    chat = consented_chat()
    n = len(sent())
    album(chat, None, [(120, 90, 40), (40, 90, 120)])
    wait_reply(chat, n, lambda p: "légende de la photo" in p.get("text", ""), timeout=30)
    time.sleep(8)
    hints = [m for m in sent(n) if str(m["params"].get("chat_id")) == str(chat) and "légende de la photo" in m["params"].get("text", "")]
    assert len(hints) == 1


def test_search_shows_a_photo_card_and_the_button_sends_the_album(db, auto_publish):  # noqa: F811
    owner = consented_chat()
    n = len(sent())
    album(owner, f"/annonce Chambre meublée à {PLACE}, 350 DT, wifi [mock:place={PLACE}]",
          [(210, 80, 80), (80, 210, 80), (80, 80, 210), (210, 210, 80)])
    p = wait_reply(owner, n, lambda p: "Ce que j'ai lu" in p["text"], timeout=150)
    lid, status, photos = owner_listing(db, owner)
    assert status == "published" and photos == 4, p["text"]

    seeker = consented_chat()
    n = len(sent())
    push(text_msg(seeker, f"je cherche une chambre près de {PLACE}"))
    wait_reply(seeker, n, lambda p: "annonce" in p.get("text", "").lower(), timeout=120)
    card = wait_reply(seeker, n, lambda p: (p.get("reply_markup") or {}).get("inline_keyboard", [[{}]])[0][0].get("callback_data")
                      == f"ph:{lid}", timeout=60, method="sendPhoto")
    assert card["photo"]["jpeg"] and card["photo"]["bytes"] > 10_000 and card["parse_mode"] == "HTML"
    assert card["reply_markup"]["inline_keyboard"][0][0]["text"] == "📷 Voir les 4 photos"
    assert card["caption"].split(".")[0].isdigit() and "350 DT/mois" in card["caption"]

    n = len(sent())
    cb = button(seeker, f"ph:{lid}")
    push(cb)
    group = wait_reply(seeker, n, timeout=60, method="sendMediaGroup")
    assert [m["media"] for m in group["media"]] == ["attach://p0", "attach://p1", "attach://p2", "attach://p3"]
    assert all(group[f"p{i}"]["jpeg"] for i in range(4)) and group["media"][0]["caption"].startswith("Chambre meublée")
    cb_id = cb["callback_query"]["id"]
    assert any(m["method"] == "answerCallbackQuery" and m["params"].get("callback_query_id") == cb_id for m in sent(n))


def test_photos_button_of_an_unknown_listing(db):  # noqa: F811
    chat = consented_chat()
    n = len(sent())
    push(button(chat, "ph:00000000-0000-4000-8000-0000000000ff"))
    wait_reply(chat, n, lambda p: "plus de photo" in p.get("text", ""))
