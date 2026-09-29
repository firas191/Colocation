"""Reference client for the /v1 API: builds the canonical string and signs it
exactly as docs/API_SIGNING.md describes. Used by the contract tests; the
website server will use the TypeScript version of the same algorithm.

Canonical string (lines joined with "\\n"):
    FS1-HMAC-SHA256
    <X-Timestamp>
    <METHOD>
    <path, e.g. /v1/users/sync>
    <canonical query>
    <X-Request-Id>
    <X-User-Id or empty>
    <X-Idempotency-Key or empty>
    <X-Client-Ip or empty>
    <hex sha256 of the raw body bytes>
X-Signature = lowercase hex HMAC-SHA256(key = UTF-8 bytes of the secret, message = canonical string).
"""
from __future__ import annotations

import hashlib
import hmac
import json
import time
import uuid
from urllib.parse import quote

import httpx

JS_SAFE = "-_.!~*'()"  # characters encodeURIComponent leaves unescaped


def canonical_query(params: dict | list | None) -> str:
    if not params:
        return ""
    items = params.items() if isinstance(params, dict) else params
    pairs = []
    for k, v in items:
        for x in (v if isinstance(v, (list, tuple)) else [v]):
            pairs.append((quote(str(k), safe=JS_SAFE), quote(str(x), safe=JS_SAFE)))
    pairs.sort(key=lambda p: p[0])  # stable: repeated keys keep their order
    return "&".join(f"{k}={v}" for k, v in pairs)


def canonical_string(ts: str, method: str, path: str, query: str, request_id: str, user_id: str,
                     idem: str, client_ip: str, body: bytes) -> str:
    return "\n".join([
        "FS1-HMAC-SHA256", ts, method.upper(), path, query, request_id, user_id or "",
        idem or "", client_ip or "", hashlib.sha256(body).hexdigest(),
    ])


def sign(secret: str, canonical: str) -> str:
    return hmac.new(secret.encode("utf-8"), canonical.encode("utf-8"), hashlib.sha256).hexdigest()


class Client:
    def __init__(self, base_url: str, key_id: str, secret: str, timeout: float = 30.0):
        self.base_url = base_url.rstrip("/")
        self.key_id, self.secret = key_id, secret
        self.http = httpx.Client(timeout=timeout)

    def build(self, method: str, path: str, *, body=None, raw_body: bytes | None = None, params=None,
              user_id: str = "", idem: str | None = None, client_ip: str = "", request_id: str | None = None,
              ts: int | None = None, headers: dict | None = None):
        """Return (url, headers, body_bytes) for a correctly signed request."""
        if raw_body is None:
            raw_body = b"" if body is None else json.dumps(body, ensure_ascii=False).encode("utf-8")
        request_id = request_id or str(uuid.uuid4())
        ts_s = str(int(time.time()) if ts is None else ts)
        q = canonical_query(params)
        canon = canonical_string(ts_s, method, path, q, request_id, user_id, idem or "", client_ip, raw_body)
        h = {
            "X-Key-Id": self.key_id,
            "X-Timestamp": ts_s,
            "X-Request-Id": request_id,
            "X-Signature": sign(self.secret, canon),
            "Accept-Language": "en",
        }
        if user_id:
            h["X-User-Id"] = user_id
        if idem:
            h["X-Idempotency-Key"] = idem
        if client_ip:
            h["X-Client-Ip"] = client_ip
        if raw_body:
            h["Content-Type"] = "application/json"
        if headers:
            h.update(headers)
        url = self.base_url + path + (("?" + q) if q else "")
        return url, h, raw_body

    def send(self, method: str, url: str, headers: dict, body: bytes) -> httpx.Response:
        return self.http.request(method, url, headers=headers, content=body)

    def call(self, method: str, path: str, **kw) -> httpx.Response:
        url, h, b = self.build(method, path, **kw)
        return self.send(method, url, h, b)
