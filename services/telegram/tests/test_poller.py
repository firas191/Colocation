"""Telegram relay: order, retry until n8n accepts, confirmation offset, token never logged."""
import json
import logging
import sys
from pathlib import Path

import httpx

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import poller  # noqa: E402

TOKEN = "123456:SECRET-test-token"


def make(monkeypatch, n8n_codes):
    monkeypatch.setenv("TELEGRAM_BOT_TOKEN", TOKEN)
    monkeypatch.setenv("TELEGRAM_API_BASE", "https://tg.test")
    monkeypatch.setenv("N8N_TELEGRAM_URL", "http://n8n.test/webhook/telegram/update")
    monkeypatch.setenv("INTERNAL_SERVICE_TOKEN", "internal-x")
    seen = {"offsets": [], "posted": [], "headers": []}
    batches = [[{"update_id": 10, "message": {"text": "a"}}, {"update_id": 11, "message": {"text": "b"}}], []]
    codes = list(n8n_codes)

    def handler(req: httpx.Request):
        if req.url.host == "tg.test":
            assert req.url.path == f"/bot{TOKEN}/getUpdates"
            seen["offsets"].append(req.url.params.get("offset"))
            return httpx.Response(200, json={"ok": True, "result": batches.pop(0) if batches else []})
        seen["posted"].append(json.loads(req.content)["update_id"])
        seen["headers"].append(req.headers.get("X-Internal-Token"))
        seen.setdefault("bots", []).append(req.headers.get("X-Telegram-Bot"))
        return httpx.Response(codes.pop(0) if codes else 200)
    return seen, httpx.Client(transport=httpx.MockTransport(handler))


def test_updates_handed_over_in_order_and_confirmed(monkeypatch):
    seen, client = make(monkeypatch, [200, 200])
    poller.run(max_rounds=2, client=client, sleep=lambda s: None)
    assert seen["posted"] == [10, 11]
    assert seen["offsets"] == [None, "12"]           # confirmed only after both were accepted
    assert seen["headers"] == ["internal-x", "internal-x"]


def test_bot_named_by_a_hash_not_by_its_token(monkeypatch):
    """F-060: n8n keeps handled update ids per bot; the bot is named by a hash, never by the token or its id part."""
    seen, client = make(monkeypatch, [200, 200])
    poller.run(max_rounds=2, client=client, sleep=lambda s: None)
    key = poller.bot_key(TOKEN)
    assert seen["bots"] == [key, key] and len(key) == 16 and "123456" not in key and key != poller.bot_key("654321:other")


def test_n8n_down_retries_the_same_update(monkeypatch):
    seen, client = make(monkeypatch, [503, 503, 200, 200])
    waits = []
    poller.run(max_rounds=2, client=client, sleep=waits.append)
    assert seen["posted"] == [10, 10, 10, 11]        # nothing skipped, order kept
    assert waits == [1, 2] and seen["offsets"] == [None, "12"]


def test_token_never_logged(monkeypatch, caplog):
    monkeypatch.setenv("TELEGRAM_BOT_TOKEN", TOKEN)
    monkeypatch.setenv("TELEGRAM_API_BASE", "https://tg.test")

    def boom(req):
        raise httpx.ConnectError(f"cannot reach {req.url}")
    caplog.set_level(logging.DEBUG)
    poller.run(max_rounds=2, client=httpx.Client(transport=httpx.MockTransport(boom)), sleep=lambda s: None)
    assert "polling failed: ConnectError" in caplog.text and TOKEN not in caplog.text


def test_no_token_is_idle(monkeypatch, caplog):
    monkeypatch.setenv("TELEGRAM_BOT_TOKEN", "")
    caplog.set_level(logging.WARNING)
    assert poller.run(max_rounds=1) == 0
    assert "idle" in caplog.text
