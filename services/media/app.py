"""Media service (spec 5.1): photo processing, presigned uploads, video frames and PDF text (phase 4).
Compute only: reads and writes objects, returns JSON; n8n writes the database."""
from __future__ import annotations

import base64
import binascii
import os
import re
import sys
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

from fastapi import Request, Response
from pydantic import BaseModel, Field, field_validator

sys.path.insert(0, str(Path(__file__).parent))
from fs_common import ServiceError, create_app  # noqa: E402
import imaging  # noqa: E402
import storage  # noqa: E402

VERSION = "0.1.0"
KEY_RE = re.compile(r"^[a-z0-9][a-z0-9/_.-]{0,250}$")
UPLOAD_TYPES = {"image/jpeg", "image/png", "image/webp", "audio/ogg", "audio/mpeg", "audio/mp4", "audio/webm", "audio/wav",
                "video/mp4", "video/quicktime", "video/webm", "application/pdf"}

_detectors = None


def detectors():
    global _detectors
    if _detectors is None and os.environ.get("MEDIA_DISABLE_DETECTORS") != "1":
        from detectors import Detectors
        _detectors = Detectors()
    return _detectors


def _warm():
    if os.environ.get("MEDIA_WARM_DETECTORS", "1") == "1":
        detectors()


app = create_app("media", VERSION, on_startup=_warm)


def _key(v: str) -> str:
    if not KEY_RE.match(v) or ".." in v or "//" in v:
        raise ValueError("invalid object key")
    return v


class ProcessIn(BaseModel):
    source_key: str
    output_key: str
    blur: bool = True
    max_bytes: int = Field(15 * 1024 * 1024, ge=1, le=50 * 1024 * 1024)
    max_pixels: int = Field(40_000_000, ge=4096, le=100_000_000)
    model_config = {"extra": "forbid"}

    _k1 = field_validator("source_key", "output_key")(lambda cls, v: _key(v))


class PresignIn(BaseModel):
    key: str
    content_type: str
    expires_s: int = Field(600, ge=60, le=900)
    model_config = {"extra": "forbid"}

    _k = field_validator("key")(lambda cls, v: _key(v))

    @field_validator("content_type")
    @classmethod
    def _ct(cls, v):
        if v not in UPLOAD_TYPES:
            raise ValueError("content type not accepted")
        return v


class DeleteIn(BaseModel):
    keys: list[str] = Field(min_length=1, max_length=100)
    model_config = {"extra": "forbid"}

    @field_validator("keys")
    @classmethod
    def _ks(cls, v):
        return [_key(k) for k in v]


@app.post("/v1/images/process")
def process_image(body: ProcessIn):
    t0 = time.perf_counter()
    data = storage.get(body.source_key, body.max_bytes)
    limits = imaging.Limits(max_bytes=body.max_bytes, max_pixels=body.max_pixels)
    det = detectors() if body.blur else None
    try:
        r = imaging.process(data, detect=det, limits=limits)
    except imaging.ImageRejected as e:
        raise ServiceError("VALIDATION_FAILED", e.message, [{"field": "image", "issue": e.code}])
    storage.put(body.output_key, r.output, "image/jpeg")
    counts = {k: sum(1 for b in r.boxes if b.kind == k) for k in ("face", "text", "screen")}
    return {"mime": r.mime, "width": r.width, "height": r.height, "bytes": len(data), "sha256": r.sha256, "phash": r.phash,
            "exif": r.exif, "metrics": r.metrics,
            "blur": {"applied": bool(r.boxes), "detectors": det is not None, "counts": counts,
                     "boxes": [b.as_dict() for b in r.boxes][:100]},
            "output": {"key": body.output_key, "mime": "image/jpeg", "bytes": len(r.output), "width": r.output_width,
                       "height": r.output_height},
            "timings": {"total_ms": round((time.perf_counter() - t0) * 1000)}}


class VisionIn(BaseModel):
    """A copy of a stored, already processed photo for the vision model (P7, D-081): smaller, JPEG, base64."""
    key: str
    max_side: int = Field(1024, ge=256, le=2048)
    quality: int = Field(85, ge=50, le=95)
    model_config = {"extra": "forbid"}

    _k = field_validator("key")(lambda cls, v: _key(v))


@app.post("/v1/images/vision")
def vision_copy(body: VisionIn):
    data = storage.get(body.key, 15 * 1024 * 1024)
    try:
        out, w, h = imaging.vision_copy(data, body.max_side, body.quality)
    except imaging.ImageRejected as e:
        raise ServiceError("VALIDATION_FAILED", e.message, [{"field": "image", "issue": e.code}])
    return {"key": body.key, "mime": "image/jpeg", "width": w, "height": h, "bytes": len(out),
            "image_b64": base64.b64encode(out).decode("ascii")}


def _listing_photo_key(v: str) -> str:
    v = _key(v)
    if not v.startswith("media/"):
        raise ValueError("only processed listing photos (media/...) are sent to chats")
    return v


def _readable_key(v: str) -> str:
    """Keys a signed GET URL may be given for: processed photos (media/...) and generated documents (documents/...,
    platform P9). Never raw uploads."""
    v = _key(v)
    if not (v.startswith("media/") or v.startswith("documents/")):
        raise ValueError("only processed photos (media/...) and generated documents (documents/...) can be read")
    return v


class CardIn(BaseModel):
    """A listing's photo card for Telegram (D-086): the processed copies of its first photos, and how many there are."""
    keys: list[str] = Field(min_length=1, max_length=4)
    total: int = Field(ge=1, le=50)
    width: int = Field(960, ge=320, le=1600)
    model_config = {"extra": "forbid"}

    @field_validator("keys")
    @classmethod
    def _ks(cls, v):
        return [_listing_photo_key(k) for k in v]


@app.post("/v1/images/card")
def photo_card(body: CardIn):
    photos = [storage.get(k, 15 * 1024 * 1024) for k in body.keys]
    try:
        out, w, h = imaging.card_image(photos, more=max(0, body.total - 1), width=body.width)
    except imaging.ImageRejected as e:
        raise ServiceError("VALIDATION_FAILED", e.message, [{"field": "image", "issue": e.code}])
    return Response(out, media_type="image/jpeg", headers={"X-Image-Width": str(w), "X-Image-Height": str(h),
                                                          "Content-Disposition": 'inline; filename="card.jpg"'})


class PublicPhotoIn(BaseModel):
    """One processed listing photo, at most 1,280 px, for sending to a chat (D-086)."""
    key: str
    max_side: int = Field(1280, ge=256, le=2048)
    model_config = {"extra": "forbid"}

    _k = field_validator("key")(lambda cls, v: _listing_photo_key(v))


@app.post("/v1/images/public")
def public_photo(body: PublicPhotoIn):
    data = storage.get(body.key, 15 * 1024 * 1024)
    try:
        out, w, h = imaging.vision_copy(data, body.max_side, 85)
    except imaging.ImageRejected as e:
        raise ServiceError("VALIDATION_FAILED", e.message, [{"field": "image", "issue": e.code}])
    return Response(out, media_type="image/jpeg", headers={"X-Image-Width": str(w), "X-Image-Height": str(h)})


class EvalPhotoIn(BaseModel):
    """Evaluation photos (P7 golden set) go through the same processing as listing photos, without an upload slot.
    Only keys under eval/ can be written this way."""
    key: str
    image_b64: str = Field(min_length=100, max_length=2_000_000)
    blur: bool = True
    model_config = {"extra": "forbid"}

    @field_validator("key")
    @classmethod
    def _ek(cls, v):
        v = _key(v)
        if not v.startswith("eval/"):
            raise ValueError("evaluation photos are stored under eval/ only")
        return v


@app.post("/v1/eval/photos")
def eval_photo(body: EvalPhotoIn):
    try:
        data = base64.b64decode(body.image_b64, validate=True)
    except (binascii.Error, ValueError):
        raise ServiceError("VALIDATION_FAILED", "image_b64 is not base64", [{"field": "image_b64", "issue": "INVALID"}])
    det = detectors() if body.blur else None
    try:
        r = imaging.process(data, detect=det)
    except imaging.ImageRejected as e:
        raise ServiceError("VALIDATION_FAILED", e.message, [{"field": "image", "issue": e.code}])
    storage.put(body.key, r.output, "image/jpeg")
    counts = {k: sum(1 for b in r.boxes if b.kind == k) for k in ("face", "text", "screen")}
    return {"key": body.key, "sha256": r.sha256, "phash": r.phash, "width": r.output_width, "height": r.output_height,
            "blur": {"applied": bool(r.boxes), "detectors": det is not None, "counts": counts}, "metrics": r.metrics}


@app.post("/v1/storage/presign")
def presign(body: PresignIn):
    url = storage.presign_put(body.key, body.content_type, body.expires_s)
    expires = datetime.now(timezone.utc) + timedelta(seconds=body.expires_s)
    return {"method": "PUT", "url": url, "headers": {"Content-Type": body.content_type},
            "expires_at": expires.isoformat(timespec="seconds"), "key": body.key}


class PresignGetIn(BaseModel):
    """Signed GET URLs for processed listing photos (platform P2: listing page, search covers, favourites) and for
    generated documents (P9). Only keys under media/ (the processed copies: EXIF removed, faces and text blurred) and
    documents/; never raw uploads."""
    keys: list[str] = Field(default_factory=list, max_length=60)
    expires_s: int = Field(900, ge=60, le=3600)
    model_config = {"extra": "forbid"}

    @field_validator("keys")
    @classmethod
    def _ks(cls, v):
        return [_readable_key(k) for k in v]


@app.post("/v1/storage/presign-get")
def presign_get(body: PresignGetIn):
    expires = (datetime.now(timezone.utc) + timedelta(seconds=body.expires_s)).isoformat(timespec="seconds")
    return {"urls": [{"key": k, "url": storage.presign_get(k, body.expires_s), "expires_at": expires} for k in body.keys]}


@app.post("/v1/storage/head")
def head(body: DeleteIn):
    out = []
    for k in body.keys:
        try:
            out.append({"key": k, "exists": True, **storage.head(k)})
        except ServiceError as e:
            if e.code != "NOT_FOUND":
                raise
            out.append({"key": k, "exists": False, "bytes": None, "content_type": None})
    return {"objects": out}


@app.post("/v1/storage/delete")
def delete(body: DeleteIn):
    return {"deleted": storage.delete(body.keys)}


# ---------- PDF rendering (platform P9, PLATFORM_SPEC 6.7, D-108) ----------------------------------------------------
class PdfIn(BaseModel):
    """HTML filled by n8n from a document template -> a PDF written to storage under documents/. The HTML may not
    load anything: every external URL, file and image reference is refused (the template is self-contained)."""
    html: str = Field(min_length=1, max_length=500_000)
    key: str
    model_config = {"extra": "forbid"}

    @field_validator("key")
    @classmethod
    def _k(cls, v):
        v = _key(v)
        if not v.startswith("documents/") or not v.endswith(".pdf"):
            raise ValueError("documents are written under documents/ as .pdf")
        return v


def _no_fetch(url, *a, **k):
    # WeasyPrint logs a refused resource and renders without it
    raise ValueError(f"resource refused: {url[:80]}")


@app.post("/v1/pdf/render")
def pdf_render(body: PdfIn):
    import hashlib
    import weasyprint
    t0 = time.perf_counter()
    doc = weasyprint.HTML(string=body.html, url_fetcher=_no_fetch).render()
    data = doc.write_pdf()
    storage.put(body.key, data, "application/pdf")
    return {"key": body.key, "bytes": len(data), "sha256": hashlib.sha256(data).hexdigest(), "pages": len(doc.pages),
            "ms": round((time.perf_counter() - t0) * 1000, 1)}
