"""Telegram relay, album sender (D-086): photos from the Media service, one sendMediaGroup, token never in logs."""
import json
import logging
import sys
import threading
from pathlib import Path

import httpx
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import album  # noqa: E402

TOKEN = "123456:SECRET-test-token"
CFG = {"token": TOKEN, "api": "https://tg.test", "internal": "internal-x", "media": "http://media.test"}


def transport(seen, tg_ok=True, media_code=200):
    def handler(req: httpx.Request):
        if req.url.host == "media.test":
            assert req.url.path == "/v1/images/public" and req.headers["X-Internal-Token"] == "internal-x"
            seen.setdefault("media", []).append(json.loads(req.content)["key"])
            return httpx.Response(media_code, content=b"\xff\xd8jpeg-bytes-" + json.loads(req.content)["key"].encode())
        seen["method"] = req.url.path.rsplit("/", 1)[-1]
        seen["path_has_token"] = TOKEN in req.url.path
        seen["body"] = req.content
        return httpx.Response(200, json={"ok": True, "result": []} if tg_ok else {"ok": False, "description": "Bad Request"})
    return httpx.MockTransport(handler)


def test_several_photos_go_as_one_media_group():
    seen = {}
    with httpx.Client(transport=transport(seen)) as c:
        out = album.send_album(c, CFG, 42, ["media/l1/a.jpg", "media/l1/b.jpg", "media/l1/c.jpg"], "Annonce 1")
    assert out == {"ok": True, "sent": 3} and seen["media"] == ["media/l1/a.jpg", "media/l1/b.jpg", "media/l1/c.jpg"]
    assert seen["method"] == "sendMediaGroup" and seen["path_has_token"]
    body = seen["body"].decode("latin-1")
    media = json.loads(body.split('name="media"')[1].split("\r\n\r\n", 1)[1].split("\r\n--", 1)[0])
    assert [m["media"] for m in media] == ["attach://p0", "attach://p1", "attach://p2"]
    assert media[0]["caption"] == "Annonce 1" and "caption" not in media[1]
    assert body.count("image/jpeg") == 3 and "jpeg-bytes-media/l1/c.jpg" in body


def test_one_photo_goes_as_a_photo():
    seen = {}
    with httpx.Client(transport=transport(seen)) as c:
        assert album.send_album(c, CFG, 42, ["media/l1/a.jpg"])["sent"] == 1
    assert seen["method"] == "sendPhoto"


def test_failures_are_reported():
    with httpx.Client(transport=transport({}, media_code=404)) as c, pytest.raises(RuntimeError, match="media service"):
        album.send_album(c, CFG, 42, ["media/l1/a.jpg"])
    with httpx.Client(transport=transport({}, tg_ok=False)) as c, pytest.raises(RuntimeError, match="Bad Request"):
        album.send_album(c, CFG, 42, ["media/l1/a.jpg", "media/l1/b.jpg"])


@pytest.mark.parametrize("body", [{"chat_id": "42", "keys": ["media/a.jpg"]}, {"chat_id": 42, "keys": []},
                                  {"chat_id": 42, "keys": ["media/a.jpg"] * 11}, {"chat_id": 42, "keys": ["uploads/a.jpg"]},
                                  {"chat_id": 42, "keys": ["media/../x.jpg"]}, {"chat_id": 42, "keys": ["media/a.jpg"], "caption": "x" * 1025}])
def test_bad_requests_are_refused(body):
    with pytest.raises(album.BadRequest):
        album.check(body)


def test_server_needs_the_internal_token_and_never_logs_the_token(caplog):
    seen = {}
    srv = album.serve(CFG, 0, client_factory=lambda: httpx.Client(transport=transport(seen, tg_ok=False)))
    port = srv.server_address[1]
    try:
        with httpx.Client() as c, caplog.at_level(logging.DEBUG):
            body = {"chat_id": 7, "keys": ["media/l1/a.jpg", "media/l1/b.jpg"]}
            assert c.post(f"http://127.0.0.1:{port}/v1/send-album", json=body).status_code == 401
            assert c.post(f"http://127.0.0.1:{port}/v1/send-album", json=body,
                          headers={"X-Internal-Token": "wrong"}).status_code == 401
            r = c.post(f"http://127.0.0.1:{port}/v1/send-album", json={"chat_id": "7"}, headers={"X-Internal-Token": "internal-x"})
            assert r.status_code == 400
            r = c.post(f"http://127.0.0.1:{port}/v1/send-album", json=body, headers={"X-Internal-Token": "internal-x"})
            assert r.status_code == 502 and r.json()["error"] == "send_failed"      # Telegram refused (mock)
        assert TOKEN not in caplog.text and TOKEN not in r.text
    finally:
        srv.shutdown()
