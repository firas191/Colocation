"""Shared plumbing for the compute services (spec 5.1: compute only, no LLM calls, no business tables).

- Every route except GET /health needs the header X-Internal-Token equal to INTERNAL_SERVICE_TOKEN
  (spec 5.4 item 4), compared in constant time. Without a configured token the service refuses to start.
- Errors use one shape: {"error": {"code": "...", "message": "...", "details": [...]}} with the HTTP status of
  the error code. Stack traces never reach the caller.
- Request bodies are capped (MAX_BODY_BYTES) before they are read.
"""
from __future__ import annotations

import hmac
import logging
import os
import time
from contextlib import asynccontextmanager
from typing import Any

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse

STATUS = {"VALIDATION_FAILED": 422, "UNAUTHENTICATED": 401, "NOT_FOUND": 404, "PAYLOAD_TOO_LARGE": 413,
          "UNSUPPORTED_MEDIA": 415, "UPSTREAM_UNAVAILABLE": 503, "INTERNAL": 500}

log = logging.getLogger("fs")


class ServiceError(Exception):
    def __init__(self, code: str, message: str, details: list | None = None, status: int | None = None):
        super().__init__(message)
        self.code, self.message, self.details = code, message, details or []
        self.status = status or STATUS.get(code, 422)


def error_body(code: str, message: str, details: list | None = None) -> dict[str, Any]:
    return {"error": {"code": code, "message": message, "details": details or []}}


def create_app(name: str, version: str, max_body_bytes: int | None = None, token: str | None = None,
               on_startup=None) -> FastAPI:
    token = token if token is not None else os.environ.get("INTERNAL_SERVICE_TOKEN", "")
    if len(token) < 16:
        raise RuntimeError("INTERNAL_SERVICE_TOKEN is missing or shorter than 16 characters")
    limit = max_body_bytes or int(os.environ.get("MAX_BODY_BYTES", str(2 * 1024 * 1024)))
    @asynccontextmanager
    async def lifespan(_app):
        if on_startup:
            on_startup()
        yield

    app = FastAPI(title=f"flatshare-{name}", version=version, docs_url=None, redoc_url=None, openapi_url=None,
                  lifespan=lifespan)
    app.state.started = time.time()

    @app.middleware("http")
    async def guard(request: Request, call_next):
        if request.url.path != "/health":
            given = request.headers.get("x-internal-token", "")
            if not hmac.compare_digest(given.encode(), token.encode()):
                return JSONResponse(error_body("UNAUTHENTICATED", "missing or wrong internal token"), status_code=401)
            n = request.headers.get("content-length")
            if n is not None and (not n.isdigit() or int(n) > limit):
                return JSONResponse(error_body("PAYLOAD_TOO_LARGE", f"request body over {limit} bytes"), status_code=413)
        try:
            return await call_next(request)
        except Exception:                                    # last resort: never a stack trace to the caller
            log.exception("unhandled error on %s", request.url.path)
            return JSONResponse(error_body("INTERNAL", "internal error"), status_code=500)

    @app.exception_handler(ServiceError)
    async def service_error(_: Request, e: ServiceError):
        return JSONResponse(error_body(e.code, e.message, e.details), status_code=e.status)

    @app.exception_handler(RequestValidationError)
    async def validation_error(_: Request, e: RequestValidationError):
        details = [{"field": ".".join(str(p) for p in err.get("loc", [])[1:]) or "body", "issue": err.get("type", "invalid")}
                   for err in e.errors()]
        return JSONResponse(error_body("VALIDATION_FAILED", "request does not match the schema", details), status_code=422)

    @app.get("/health")
    async def health():
        return {"status": "ok", "service": name, "version": version, "uptime_s": round(time.time() - app.state.started)}

    return app
