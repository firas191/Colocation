"""Telegram relay, outgoing part (D-086): sends a listing's photos to a chat as one album.

n8n's Telegram node cannot upload several files in one message (its "send media group" takes file ids or public URLs
only, and the photos are not public). n8n asks this relay instead, on the internal network:

    POST /v1/send-album   X-Internal-Token: ...   {"chat_id": 123, "keys": ["media/<listing>/<id>.jpg", ...], "caption": "..."}

For each key the relay gets the processed copy (EXIF removed, faces and text blurred) from the Media service
(/v1/images/public), then uploads them to Telegram in one sendMediaGroup call (sendPhoto for a single photo).
The relay holds the bot token; n8n never builds a Telegram URL. URLs are never logged (they contain the token).

Environment: MEDIA_URL (default http://media:8000), RELAY_PORT (default 8099), plus the relay's TELEGRAM_* and
INTERNAL_SERVICE_TOKEN.
"""
from __future__ import annotations

import hmac
import json
import logging
import os
import re
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import httpx

log = logging.getLogger("telegram-relay.album")
for _name in ("httpx", "httpcore"):                 # they log request URLs, which contain the bot token
    logging.getLogger(_name).setLevel(logging.WARNING)
KEY_RE = re.compile(r"^media/[a-z0-9][a-z0-9/_.-]{0,240}$")
MAX_PHOTOS = 10                      # Telegram's limit for one media group


class BadRequest(Exception):
    pass


def check(body: dict) -> tuple[int, list[str], str]:
    if not isinstance(body, dict):
        raise BadRequest("body must be an object")
    chat = body.get("chat_id")
    if not isinstance(chat, int) or isinstance(chat, bool):
        raise BadRequest("chat_id must be an integer")
    keys = body.get("keys")
    if not isinstance(keys, list) or not 1 <= len(keys) <= MAX_PHOTOS:
        raise BadRequest(f"keys must be a list of 1 to {MAX_PHOTOS} photos")
    for k in keys:
        if not isinstance(k, str) or not KEY_RE.match(k) or ".." in k or "//" in k:
            raise BadRequest("keys must be processed listing photos (media/...)")
    caption = body.get("caption") or ""
    if not isinstance(caption, str) or len(caption) > 1024:
        raise BadRequest("caption must be text of at most 1024 characters")
    return chat, keys, caption


def send_album(c: httpx.Client, cfg: dict, chat_id: int, keys: list[str], caption: str = "") -> dict:
    photos = []
    for k in keys:
        r = c.post(f"{cfg['media']}/v1/images/public", json={"key": k}, headers={"X-Internal-Token": cfg["internal"]},
                   timeout=60)
        if r.status_code != 200:
            raise RuntimeError(f"media service answered {r.status_code} for a photo")
        photos.append(r.content)
    base = f"{cfg['api']}/bot{cfg['token']}"
    if len(photos) == 1:
        data = {"chat_id": str(chat_id)}
        if caption:
            data["caption"] = caption
        r = c.post(f"{base}/sendPhoto", data=data, files={"photo": ("photo.jpg", photos[0], "image/jpeg")}, timeout=120)
    else:
        media = [{"type": "photo", "media": f"attach://p{i}", **({"caption": caption} if caption and i == 0 else {})}
                 for i in range(len(photos))]
        files = {f"p{i}": (f"p{i}.jpg", b, "image/jpeg") for i, b in enumerate(photos)}
        r = c.post(f"{base}/sendMediaGroup", data={"chat_id": str(chat_id), "media": json.dumps(media)}, files=files,
                   timeout=120)
    try:
        body = r.json()
    except ValueError:
        body = {}
    if not body.get("ok"):
        raise RuntimeError(f"Telegram answered {r.status_code}: {str(body.get('description', ''))[:200]}")
    return {"ok": True, "sent": len(photos)}


def make_handler(cfg: dict, client_factory=httpx.Client):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *a):          # the default logs request lines; nothing useful, nothing secret either
            pass

        def answer(self, code: int, body: dict):
            data = json.dumps(body).encode()
            self.send_response(code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def do_POST(self):
            if self.path != "/v1/send-album":
                return self.answer(404, {"ok": False, "error": "not_found"})
            given = self.headers.get("X-Internal-Token", "")
            if not cfg["internal"] or not hmac.compare_digest(given.encode(), cfg["internal"].encode()):
                return self.answer(401, {"ok": False, "error": "unauthenticated"})
            if not cfg["token"]:
                return self.answer(503, {"ok": False, "error": "no_bot_token"})
            try:
                raw = self.rfile.read(min(int(self.headers.get("Content-Length") or 0), 64 * 1024))
                chat, keys, caption = check(json.loads(raw or b"{}"))
            except (BadRequest, ValueError) as e:
                return self.answer(400, {"ok": False, "error": "bad_request", "detail": str(e)[:200]})
            try:
                with client_factory() as c:
                    return self.answer(200, send_album(c, cfg, chat, keys, caption))
            except Exception as e:  # noqa: BLE001  (media service or Telegram failed: say so, without URLs)
                log.warning("album not sent: %s: %s", type(e).__name__, str(e)[:200])
                return self.answer(502, {"ok": False, "error": "send_failed", "detail": str(e)[:200]})
    return Handler


def serve(cfg: dict, port: int, client_factory=httpx.Client) -> ThreadingHTTPServer:
    srv = ThreadingHTTPServer(("0.0.0.0", port), make_handler(cfg, client_factory))
    threading.Thread(target=srv.serve_forever, name="album-server", daemon=True).start()
    log.info("album sender listening on port %s", port)
    return srv
