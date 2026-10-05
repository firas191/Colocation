#!/usr/bin/env python3
"""Telegram long-polling relay (D-079). Transport only: no decision, no storage, no model.

Asks Telegram for new updates with long polling (getUpdates, `timeout` seconds held open), and hands each update,
unchanged, to the n8n workflow wf.channel.telegram (internal webhook, X-Internal-Token). An update is confirmed to
Telegram (the next offset) only after n8n accepted it, so nothing is lost while n8n is down; n8n drops repeats by
update_id. Nothing on this machine is reachable from the internet: every connection starts here.

Environment: TELEGRAM_BOT_TOKEN (no token: the relay waits, the rest of the stack is unaffected), TELEGRAM_API_BASE,
N8N_TELEGRAM_URL, INTERNAL_SERVICE_TOKEN, POLL_TIMEOUT_S (default 50).
"""
from __future__ import annotations

import hashlib
import logging
import os
import sys
import time

import httpx

log = logging.getLogger("telegram-relay")


def config() -> dict:
    return {"token": os.environ.get("TELEGRAM_BOT_TOKEN", "").strip(),
            "api": os.environ.get("TELEGRAM_API_BASE", "https://api.telegram.org").rstrip("/"),
            "n8n": os.environ.get("N8N_TELEGRAM_URL", "http://n8n:5678/webhook/telegram/update"),
            "internal": os.environ.get("INTERNAL_SERVICE_TOKEN", ""),
            "timeout": int(os.environ.get("POLL_TIMEOUT_S", "50"))}


def get_updates(c: httpx.Client, cfg: dict, offset: int | None) -> list[dict]:
    params = {"timeout": cfg["timeout"], "allowed_updates": '["message","callback_query"]'}
    if offset is not None:
        params["offset"] = offset
    r = c.get(f"{cfg['api']}/bot{cfg['token']}/getUpdates", params=params, timeout=cfg["timeout"] + 15)
    body = r.json()
    if not body.get("ok"):
        raise RuntimeError(f"getUpdates: HTTP {r.status_code} {str(body.get('description', ''))[:200]}")
    return body.get("result", [])


def bot_key(token: str) -> str:
    """Names the bot without revealing its token: n8n keeps handled update ids per bot, because a new bot's update ids
    can overlap with the old bot's (F-060)."""
    return hashlib.sha256(token.encode()).hexdigest()[:16]


def hand_over(c: httpx.Client, cfg: dict, update: dict) -> bool:
    r = c.post(cfg["n8n"], json=update, headers={"X-Internal-Token": cfg["internal"], "X-Telegram-Bot": bot_key(cfg["token"])},
               timeout=30)
    if r.status_code // 100 != 2:
        log.warning("n8n answered %s for update %s", r.status_code, update.get("update_id"))
        return False
    return True


def run(max_rounds: int | None = None, client: httpx.Client | None = None, sleep=time.sleep) -> int:
    """max_rounds: stop after that many getUpdates calls (tests); None = forever. client, sleep: injected by tests."""
    cfg = config()
    if not cfg["token"]:
        log.warning("TELEGRAM_BOT_TOKEN is empty: the Telegram relay is idle (see docs/RUNBOOK.md, Telegram bot)")
        while max_rounds is None:
            sleep(300)
        return 0
    offset, delay, rounds = None, 1, 0
    with (client or httpx.Client()) as c:
        while max_rounds is None or rounds < max_rounds:
            rounds += 1
            try:
                for u in get_updates(c, cfg, offset):
                    while not hand_over(c, cfg, u):          # keep the order; retry until n8n accepts it
                        sleep(min(delay, 60))
                        delay = min(delay * 2, 60)
                    offset = int(u["update_id"]) + 1
                    delay = 1
            except Exception as e:  # noqa: BLE001  (network, Telegram or n8n down: wait and try again)
                # the token is part of Telegram's URL: never log a URL
                log.warning("polling failed: %s; retrying in %s s", type(e).__name__, delay)
                sleep(delay)
                delay = min(delay * 2, 60)
    return 0


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    logging.getLogger("httpx").setLevel(logging.WARNING)       # httpx logs request URLs, which contain the token
    sys.exit(run())
