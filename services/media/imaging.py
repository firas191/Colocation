"""Photo processing without I/O (spec 11.2 steps 1 to 4): validation, EXIF read and strip, hashes, blurring,
capture metrics. Detectors are passed in, so tests can replace them.

Decisions (docs/DECISIONS.md D-070):
- Accepted types: JPEG, PNG, WebP, sniffed from the bytes (the file name and declared type are not trusted).
  HEIC is refused: the only Pillow plugin ships GPL binaries. Animated images are refused.
- Pixel and side limits are checked from the header before decoding; Pillow's decompression-bomb warning is
  turned into an error.
- The stored file is rebuilt from pixels and saved as JPEG without EXIF, ICC profile, comments or XMP.
- sha256 is of the uploaded bytes (exact duplicates); the 64-bit pHash is of the upright image before blurring,
  so a copy of someone else's photo still matches after our own blurring.
"""
from __future__ import annotations

import hashlib
import io
import warnings
from dataclasses import dataclass, field
from datetime import datetime

import filetype
import imagehash
import numpy as np
from PIL import ExifTags, Image, ImageFile, ImageOps

ALLOWED = {"image/jpeg": "JPEG", "image/png": "PNG", "image/webp": "WEBP"}


@dataclass
class Limits:
    max_bytes: int = 15 * 1024 * 1024
    max_pixels: int = 40_000_000
    max_side: int = 10_000
    min_side: int = 64
    output_max_side: int = 2560
    output_quality: int = 85


@dataclass
class Box:
    kind: str           # face | text | screen
    x: int
    y: int
    w: int
    h: int
    score: float

    def as_dict(self):
        return {"kind": self.kind, "x": self.x, "y": self.y, "w": self.w, "h": self.h, "score": round(float(self.score), 3)}


class ImageRejected(Exception):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code, self.message = code, message


@dataclass
class Result:
    mime: str
    width: int
    height: int
    sha256: str
    phash: str
    exif: dict
    metrics: dict
    boxes: list = field(default_factory=list)
    output: bytes = b""
    output_width: int = 0
    output_height: int = 0


def sniff(data: bytes, limits: Limits) -> str:
    if not data:
        raise ImageRejected("EMPTY", "the file is empty")
    if len(data) > limits.max_bytes:
        raise ImageRejected("TOO_LARGE", f"the file is over {limits.max_bytes} bytes")
    kind = filetype.guess(data[:4096])
    mime = kind.mime if kind else None
    if mime not in ALLOWED:
        raise ImageRejected("UNSUPPORTED_TYPE", f"type {mime or 'unknown'} is not accepted (JPEG, PNG, WebP)")
    return mime


def _ratio(v):
    try:
        return float(v)
    except (TypeError, ValueError, ZeroDivisionError):
        return None


def _gps_decimal(dms, ref):
    try:
        d, m, s = (_ratio(x) for x in dms)
        if None in (d, m, s):
            return None
        v = d + m / 60 + s / 3600
        return round(-v if ref in ("S", "W") else v, 6)
    except (TypeError, ValueError):
        return None


def read_exif(img: Image.Image) -> dict:
    """Capture time, device and GPS for the trust check (spec 11.2 step 2). GPS is returned to the caller,
    which must never expose it (spec: 'Never expose GPS')."""
    out = {"captured_at": None, "make": None, "model": None, "software": None, "orientation": None,
           "has_gps": False, "gps": None, "tags": 0}
    try:
        ex = img.getexif()
    except Exception:
        return out
    out["tags"] = len(ex)
    base = {ExifTags.TAGS.get(k, k): v for k, v in ex.items()}
    sub = {}
    try:
        sub = {ExifTags.TAGS.get(k, k): v for k, v in ex.get_ifd(ExifTags.IFD.Exif).items()}
    except Exception:
        pass
    when = sub.get("DateTimeOriginal") or base.get("DateTime")
    if isinstance(when, str):
        try:
            out["captured_at"] = datetime.strptime(when.strip("\x00 "), "%Y:%m:%d %H:%M:%S").isoformat()
        except ValueError:
            out["captured_at"] = None
    for k in ("Make", "Model", "Software"):
        v = base.get(k)
        out[k.lower()] = v.strip("\x00 ")[:80] if isinstance(v, str) else None
    out["orientation"] = base.get("Orientation")
    try:
        gps = {ExifTags.GPSTAGS.get(k, k): v for k, v in ex.get_ifd(ExifTags.IFD.GPSInfo).items()}
    except Exception:
        gps = {}
    if gps.get("GPSLatitude") and gps.get("GPSLongitude"):
        lat = _gps_decimal(gps["GPSLatitude"], gps.get("GPSLatitudeRef"))
        lon = _gps_decimal(gps["GPSLongitude"], gps.get("GPSLongitudeRef"))
        if lat is not None and lon is not None and -90 <= lat <= 90 and -180 <= lon <= 180:
            out["has_gps"], out["gps"] = True, {"lat": lat, "lon": lon}
    return out


def decode(data: bytes, mime: str, limits: Limits) -> tuple[Image.Image, dict]:
    """Header checks, then a full decode with the decompression-bomb warning raised as an error."""
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("error", Image.DecompressionBombWarning)
            Image.MAX_IMAGE_PIXELS = limits.max_pixels
            ImageFile.LOAD_TRUNCATED_IMAGES = False
            probe = Image.open(io.BytesIO(data), formats=[ALLOWED[mime]])
            w, h = probe.size
            if w * h > limits.max_pixels or max(w, h) > limits.max_side:
                raise ImageRejected("TOO_MANY_PIXELS", f"{w}x{h} is over the limit ({limits.max_pixels} pixels, side {limits.max_side})")
            if min(w, h) < limits.min_side:
                raise ImageRejected("TOO_SMALL", f"{w}x{h} is under the minimum side of {limits.min_side}")
            if getattr(probe, "is_animated", False) or getattr(probe, "n_frames", 1) > 1:
                raise ImageRejected("ANIMATED", "animated images are not accepted")
            probe.verify()                          # structure check; the object is unusable afterwards
            img = Image.open(io.BytesIO(data), formats=[ALLOWED[mime]])
            exif = read_exif(img)
            img.load()
    except ImageRejected:
        raise
    except (Image.DecompressionBombError, Image.DecompressionBombWarning):
        raise ImageRejected("TOO_MANY_PIXELS", "decompression bomb guard")
    except Exception as e:                         # truncated, corrupt, wrong structure
        raise ImageRejected("CORRUPT", f"the image could not be decoded ({type(e).__name__})")
    img = ImageOps.exif_transpose(img)             # upright pixels; the orientation tag is no longer needed
    if img.mode not in ("RGB", "L"):
        background = Image.new("RGB", img.size, (255, 255, 255))
        rgba = img.convert("RGBA")
        background.paste(rgba, mask=rgba.split()[3])
        img = background
    return img.convert("RGB"), exif


def metrics(rgb: np.ndarray) -> dict:
    """Capture metrics (spec 11.3): sharpness as the variance of the Laplacian on a grey copy whose long side is
    1024 px (so values compare across resolutions), exposure as mean brightness and clipped shares."""
    import cv2
    grey = cv2.cvtColor(rgb, cv2.COLOR_RGB2GRAY)
    h, w = grey.shape
    s = 1024 / max(h, w)
    if s < 1:
        grey = cv2.resize(grey, (max(1, round(w * s)), max(1, round(h * s))), interpolation=cv2.INTER_AREA)
    return {"sharpness": round(float(cv2.Laplacian(grey, cv2.CV_64F).var()), 2),
            "brightness_mean": round(float(grey.mean()), 2),
            "dark_fraction": round(float((grey < 16).mean()), 4),
            "bright_fraction": round(float((grey > 240).mean()), 4)}


def blur_boxes(rgb: np.ndarray, boxes: list[Box], pad: float = 0.15) -> np.ndarray:
    """Pixelate then blur each box (with padding). Pixelation first, so the blur cannot be undone by sharpening."""
    import cv2
    out = rgb.copy()
    h, w = out.shape[:2]
    for b in boxes:
        px, py = int(b.w * pad), int(b.h * pad)
        x0, y0 = max(0, b.x - px), max(0, b.y - py)
        x1, y1 = min(w, b.x + b.w + px), min(h, b.y + b.h + py)
        if x1 - x0 < 2 or y1 - y0 < 2:
            continue
        region = out[y0:y1, x0:x1]
        cells = max(2, min(region.shape[0], region.shape[1]) // 12)
        small = cv2.resize(region, (max(1, region.shape[1] // cells), max(1, region.shape[0] // cells)), interpolation=cv2.INTER_AREA)
        region = cv2.resize(small, (x1 - x0, y1 - y0), interpolation=cv2.INTER_NEAREST)
        k = max(3, (min(region.shape[:2]) // 4) | 1)
        out[y0:y1, x0:x1] = cv2.GaussianBlur(region, (k, k), 0)
    return out


def encode_clean(rgb: np.ndarray, limits: Limits) -> tuple[bytes, int, int]:
    """JPEG rebuilt from pixels: no EXIF, ICC profile, comment or XMP (spec 11.2 step 2)."""
    img = Image.fromarray(rgb, "RGB")
    if max(img.size) > limits.output_max_side:
        img.thumbnail((limits.output_max_side, limits.output_max_side), Image.Resampling.LANCZOS)
    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=limits.output_quality, optimize=True, exif=b"", comment=b"", icc_profile=None)
    return buf.getvalue(), img.size[0], img.size[1]


def process(data: bytes, detect=None, limits: Limits | None = None) -> Result:
    """detect(rgb) -> list[Box]; None skips detection (no blurring)."""
    limits = limits or Limits()
    mime = sniff(data, limits)
    img, exif = decode(data, mime, limits)
    rgb = np.asarray(img)
    ph = str(imagehash.phash(img, hash_size=8))
    boxes = list(detect(rgb)) if detect else []
    clean = blur_boxes(rgb, boxes) if boxes else rgb
    out, ow, oh = encode_clean(clean, limits)
    return Result(mime=mime, width=img.size[0], height=img.size[1], sha256=hashlib.sha256(data).hexdigest(), phash=ph,
                  exif=exif, metrics=metrics(rgb), boxes=boxes, output=out, output_width=ow, output_height=oh)


def vision_copy(data: bytes, max_side: int = 1024, quality: int = 85) -> tuple[bytes, int, int]:
    """A smaller JPEG of a processed photo for the vision model (D-081). The input is our own clean copy, but it is
    still checked like any image (type sniffed, size limits) before it is decoded."""
    limits = Limits()
    mime = sniff(data, limits)
    img, _ = decode(data, mime, limits)
    if max(img.size) > max_side:
        img.thumbnail((max_side, max_side), Image.Resampling.LANCZOS)
    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=quality, exif=b"", comment=b"", icc_profile=None)
    return buf.getvalue(), img.size[0], img.size[1]


def hamming(a_hex: str, b_hex: str) -> int:
    return bin(int(a_hex, 16) ^ int(b_hex, 16)).count("1")
