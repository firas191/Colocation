"""Photo pipeline unit tests (spec 15.3 'Uploads' edge cases, 11.2 steps 1 to 4). Images are generated here;
no real photo or personal data is used."""
import io
import struct
import zlib

import numpy as np
import pytest
from PIL import Image, ImageDraw

import imaging
from imaging import Box, ImageRejected, Limits


def scene(seed=1, w=800, h=600):
    """A synthetic 'room': gradients, rectangles and circles, deterministic."""
    rng = np.random.default_rng(seed)
    y, x = np.mgrid[0:h, 0:w]
    base = np.stack([(x * 255 / w), (y * 255 / h), ((x + y) * 127 / (w + h)) + 60], -1).astype(np.uint8)
    img = Image.fromarray(base)
    d = ImageDraw.Draw(img)
    for _ in range(12 if min(w, h) > 100 else 0):
        x0, y0 = int(rng.integers(0, w - 80)), int(rng.integers(0, h - 80))
        d.rectangle([x0, y0, x0 + int(rng.integers(30, 200)), y0 + int(rng.integers(30, 200))],
                    fill=tuple(int(c) for c in rng.integers(0, 255, 3)))
        d.ellipse([x0, y0, x0 + 60, y0 + 60], outline=(0, 0, 0), width=4)
    return img


def jpeg(img, **kw):
    b = io.BytesIO()
    img.save(b, "JPEG", quality=92, **kw)
    return b.getvalue()


def exif_bytes(orientation=None, gps=True):
    ex = Image.Exif()
    ex[0x010F] = "PhoneMaker"          # Make
    ex[0x0110] = "Model X"             # Model
    ex[0x0131] = "EditApp 2.0"         # Software
    if orientation:
        ex[0x0112] = orientation
    ex.get_ifd(0x8769)[0x9003] = "2026:09:30 18:45:10"     # DateTimeOriginal
    if gps:
        g = ex.get_ifd(0x8825)
        g[1], g[2] = "N", (36.0, 50.0, 30.0)             # 36.841667
        g[3], g[4] = "E", (10.0, 11.0, 24.0)             # 10.19
    return ex.tobytes()


def test_valid_jpeg_exif_read_then_stripped():
    data = jpeg(scene(), exif=exif_bytes(), comment=b"secret comment")
    r = imaging.process(data)
    assert r.mime == "image/jpeg" and (r.width, r.height) == (800, 600)
    assert r.exif["make"] == "PhoneMaker" and r.exif["model"] == "Model X" and r.exif["software"] == "EditApp 2.0"
    assert r.exif["captured_at"] == "2026-09-30T18:45:10"
    assert r.exif["has_gps"] and r.exif["gps"] == {"lat": 36.841667, "lon": 10.19}
    out = Image.open(io.BytesIO(r.output))
    assert len(out.getexif()) == 0 and "exif" not in out.info and "comment" not in out.info and "icc_profile" not in out.info
    assert b"secret comment" not in r.output and b"PhoneMaker" not in r.output and b"Exif" not in r.output[:200]
    assert len(r.sha256) == 64 and len(r.phash) == 16


def test_orientation_applied_before_hashing():
    upright = scene(2, 600, 400)
    rotated = upright.rotate(90, expand=True)                 # stored sideways, EXIF says rotate back (6 = 90 CW)
    r1 = imaging.process(jpeg(upright))
    r2 = imaging.process(jpeg(rotated, exif=exif_bytes(orientation=6, gps=False)))
    assert (r2.width, r2.height) == (r1.width, r1.height)
    assert imaging.hamming(r1.phash, r2.phash) <= 6


def test_png_with_alpha_and_webp():
    rgba = scene(3).convert("RGBA")
    rgba.putalpha(128)
    b = io.BytesIO()
    rgba.save(b, "PNG")
    r = imaging.process(b.getvalue())
    assert r.mime == "image/png" and Image.open(io.BytesIO(r.output)).mode == "RGB"
    b = io.BytesIO()
    scene(3).save(b, "WEBP", quality=80)
    assert imaging.process(b.getvalue()).mime == "image/webp"


@pytest.mark.parametrize("data,code", [
    (b"", "EMPTY"),
    (b"This is not an image, only text named photo.jpg" * 10, "UNSUPPORTED_TYPE"),
    (b"%PDF-1.7\n" + b"0" * 500, "UNSUPPORTED_TYPE"),
])
def test_rejects_empty_and_wrong_types(data, code):
    with pytest.raises(ImageRejected) as e:
        imaging.process(data)
    assert e.value.code == code


def test_rejects_oversized_file():
    with pytest.raises(ImageRejected) as e:
        imaging.process(jpeg(scene()), limits=Limits(max_bytes=1000))
    assert e.value.code == "TOO_LARGE"


def test_rejects_truncated_jpeg():
    data = jpeg(scene())
    with pytest.raises(ImageRejected) as e:
        imaging.process(data[: len(data) // 2])
    assert e.value.code == "CORRUPT"


def test_rejects_gif_and_animated_webp():
    frames = [scene(i, 200, 200) for i in range(3)]
    b = io.BytesIO()
    frames[0].save(b, "GIF", save_all=True, append_images=frames[1:])
    with pytest.raises(ImageRejected) as e:
        imaging.process(b.getvalue())
    assert e.value.code == "UNSUPPORTED_TYPE"
    b = io.BytesIO()
    frames[0].save(b, "WEBP", save_all=True, append_images=frames[1:], duration=100)
    with pytest.raises(ImageRejected) as e:
        imaging.process(b.getvalue())
    assert e.value.code == "ANIMATED"


def png_header_only(w, h):
    """A valid PNG signature and IHDR claiming w x h, with a tiny compressed body (a decompression bomb shape)."""
    def chunk(t, d):
        return struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d) & 0xFFFFFFFF)
    raw = zlib.compress(b"\x00" * 1000)
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0)) + chunk(b"IDAT", raw) + chunk(b"IEND", b"")


@pytest.mark.parametrize("w,h", [(20000, 20000), (9000, 9000), (12000, 100)])
def test_rejects_huge_dimensions_before_decoding(w, h):
    data = png_header_only(w, h)
    assert len(data) < 2000
    with pytest.raises(ImageRejected) as e:
        imaging.process(data)
    assert e.value.code == "TOO_MANY_PIXELS"


def test_rejects_tiny_images():
    with pytest.raises(ImageRejected) as e:
        imaging.process(jpeg(scene(1, 40, 40)))
    assert e.value.code == "TOO_SMALL"


def test_phash_near_duplicates_and_different_photos():
    base = scene(7)
    h0 = imaging.process(jpeg(base)).phash
    variants = {
        "recompressed": jpeg(base),
        "resized": jpeg(base.resize((400, 300))),
        "low_quality": (lambda b: (base.save(b, "JPEG", quality=30), b.getvalue())[1])(io.BytesIO()),
        "brighter": jpeg(Image.eval(base, lambda v: min(255, int(v * 1.1)))),
        "small_crop": jpeg(base.crop((16, 12, 784, 588))),
    }
    for name, data in variants.items():
        assert imaging.hamming(h0, imaging.process(data).phash) <= 6, name
    others = [imaging.process(jpeg(scene(s))).phash for s in (8, 9, 10, 11)]
    assert all(imaging.hamming(h0, o) > 6 for o in others)


def test_blur_changes_only_the_boxes():
    img = scene(4)
    checker = np.indices((120, 120)).sum(0) // 8 % 2 * 255            # fine detail where the box will be
    img.paste(Image.fromarray(np.stack([checker] * 3, -1).astype(np.uint8)), (100, 100))
    data = jpeg(img)
    box = Box("face", 100, 100, 120, 120, 0.9)
    r = imaging.process(data, detect=lambda rgb: [box])
    plain = np.asarray(Image.open(io.BytesIO(imaging.process(data).output)).convert("L"), dtype=float)
    blurred = np.asarray(Image.open(io.BytesIO(r.output)).convert("L"), dtype=float)
    inside = (slice(110, 210), slice(110, 210))
    outside = (slice(400, 580), slice(500, 780))
    assert np.abs(np.diff(blurred[inside], axis=1)).mean() < 0.5 * np.abs(np.diff(plain[inside], axis=1)).mean()
    assert np.abs(blurred[outside] - plain[outside]).mean() < 1.0
    assert [b.as_dict()["kind"] for b in r.boxes] == ["face"]


def test_metrics_sharpness_and_exposure():
    sharp = imaging.process(jpeg(scene(5))).metrics
    soft = imaging.process(jpeg(scene(5).resize((100, 75)).resize((800, 600)))).metrics
    dark = imaging.process(jpeg(Image.eval(scene(5), lambda v: v // 8))).metrics
    assert sharp["sharpness"] > 3 * soft["sharpness"]
    assert dark["brightness_mean"] < 0.3 * sharp["brightness_mean"] and dark["dark_fraction"] > 0.5


def test_output_is_downscaled_to_the_limit():
    r = imaging.process(jpeg(scene(6, 3000, 2000)), limits=Limits(output_max_side=1600))
    assert (r.output_width, r.output_height) == (1600, 1067) and (r.width, r.height) == (3000, 2000)
