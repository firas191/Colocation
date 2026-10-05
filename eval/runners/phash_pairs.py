"""Near-duplicate photo threshold (spec 11.2 step 3 and evaluation; D-069, D-082).

Near-duplicate pairs: each photo against copies made by fixed edits (crop, resize, recompression, brightness, small
rotation, a screenshot-like border, and a combination). Unrelated pairs: every pair of two different photos of the set.
The pHash is the Media service's own (services/media/imaging.process, before blurring), so the threshold measured
here is the one app.find_similar_media uses (setting media.phash_max_distance, default 6).

  python eval/runners/phash_pairs.py --dir <photo folder> --dataset eval/datasets/p7_photos_v1.jsonl --out report.json

Runs where the Media service's code and libraries are: the sandbox venv, or the fs-media container on the PC.
"""
import argparse
import io
import itertools
import json
import sys
from pathlib import Path

from PIL import Image, ImageEnhance, ImageOps

ROOT = Path(__file__).resolve().parents[2]
sys.path[:0] = [str(ROOT / "services" / "media"), str(ROOT / "services" / "common")]
import imaging  # noqa: E402


def jpeg(img: Image.Image, q: int = 90) -> bytes:
    b = io.BytesIO()
    img.convert("RGB").save(b, "JPEG", quality=q)
    return b.getvalue()


def crop(img, frac):
    w, h = img.size
    dx, dy = int(w * (1 - frac) / 2), int(h * (1 - frac) / 2)
    return img.crop((dx, dy, w - dx, h - dy))


# name -> edit. Each is what a reposted copy of a listing photo plausibly went through.
EDITS = {
    "crop_90": lambda im: jpeg(crop(im, 0.90)),
    "crop_75": lambda im: jpeg(crop(im, 0.75)),
    "resize_50": lambda im: jpeg(im.resize((im.width // 2, im.height // 2), Image.Resampling.LANCZOS)),
    "jpeg_q30": lambda im: jpeg(im, 30),
    "brighter_20": lambda im: jpeg(ImageEnhance.Brightness(im).enhance(1.2)),
    "rotate_3": lambda im: jpeg(im.rotate(3, resample=Image.Resampling.BICUBIC, expand=False)),
    "border_screenshot": lambda im: jpeg(ImageOps.expand(im, border=(0, im.height // 10, 0, im.height // 6), fill=(245, 245, 245))),
    "mirror": lambda im: jpeg(ImageOps.mirror(im)),
    "combined": lambda im: jpeg(crop(im, 0.9).resize((int(im.width * 0.45), int(im.height * 0.45)), Image.Resampling.LANCZOS), 50),
}


def phash(data: bytes) -> str:
    return imaging.process(data, detect=None).phash


def run(photos: list[tuple[str, bytes, str]], thresholds=range(0, 21)) -> dict:
    """photos: (id, bytes, group)."""
    base = {}
    near = []
    for pid, data, group in photos:
        h0 = phash(data)
        base[pid] = (h0, group)
        im = Image.open(io.BytesIO(data))
        im = ImageOps.exif_transpose(im).convert("RGB")
        for name, f in EDITS.items():
            near.append({"id": pid, "edit": name, "distance": imaging.hamming(h0, phash(f(im)))})
    unrelated = []
    for (a, (ha, ga)), (b, (hb, gb)) in itertools.combinations(sorted(base.items()), 2):
        unrelated.append({"a": a, "b": b, "same_group": ga == gb, "distance": imaging.hamming(ha, hb)})
    # Mirrored copies are reported but not counted as near duplicates to catch: pHash is not mirror-invariant.
    counted = [x for x in near if x["edit"] != "mirror"]
    rows = []
    for t in thresholds:
        tp = sum(x["distance"] <= t for x in counted)
        fp = sum(x["distance"] <= t for x in unrelated)
        fn = len(counted) - tp
        p = tp / (tp + fp) if tp + fp else None
        r = tp / (tp + fn) if tp + fn else None
        rows.append({"threshold": t, "tp": tp, "fp": fp, "fn": fn, "precision": None if p is None else round(p, 4),
                     "recall": None if r is None else round(r, 4),
                     "f1": None if not p or not r else round(2 * p * r / (p + r), 4)})
    by_edit = {}
    for name in EDITS:
        ds = sorted(x["distance"] for x in near if x["edit"] == name)
        by_edit[name] = {"n": len(ds), "min": ds[0], "median": ds[len(ds) // 2], "max": ds[-1],
                         "within_6": sum(d <= 6 for d in ds)} if ds else {"n": 0}
    ud = sorted(x["distance"] for x in unrelated)
    same = sorted(x["distance"] for x in unrelated if x["same_group"])
    return {"photos": len(base), "near_pairs": len(counted), "mirror_pairs": len(near) - len(counted), "unrelated_pairs": len(unrelated),
            "unrelated_distance": {"min": ud[0] if ud else None, "p1": ud[len(ud) // 100] if ud else None,
                                   "median": ud[len(ud) // 2] if ud else None,
                                   "same_group_min": same[0] if same else None},
            "closest_unrelated": sorted(unrelated, key=lambda x: x["distance"])[:10],
            "by_edit": by_edit, "thresholds": rows}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dir", required=True, help="photo folder with images/ (D-069)")
    ap.add_argument("--dataset", default=str(ROOT / "eval" / "datasets" / "p7_photos_v1.jsonl"))
    ap.add_argument("--pairs", default=str(ROOT / "eval" / "datasets" / "p7_photos_v1_pairs.json"))
    ap.add_argument("--out", default=None)
    a = ap.parse_args()
    rows = [json.loads(l) for l in Path(a.dataset).read_text("utf-8").splitlines() if l.strip()]
    photos = [(r["id"], (Path(a.dir) / "images" / r["file"]).read_bytes(), r["tags"][0]) for r in rows]
    rep = run(photos)
    # Pairs of real photos of the same room (not edits): distance only, they are not counted above.
    rep["same_room_pairs"] = []
    if a.pairs and Path(a.pairs).exists():
        for p in json.loads(Path(a.pairs).read_text("utf-8"))["pairs"]:
            fa, fb = Path(a.dir) / "images" / p["a"], Path(a.dir) / "images" / p["b"]
            if fa.exists() and fb.exists():
                rep["same_room_pairs"].append({**p, "distance": imaging.hamming(phash(fa.read_bytes()), phash(fb.read_bytes()))})
    for t in rep["thresholds"]:
        if t["threshold"] in (0, 2, 4, 6, 8, 10, 12, 14, 16, 20):
            print(f"threshold {t['threshold']:2}: precision {t['precision']}  recall {t['recall']}  (tp {t['tp']}, fp {t['fp']}, fn {t['fn']})")
    print("by edit:", json.dumps(rep["by_edit"]))
    print("unrelated:", json.dumps(rep["unrelated_distance"]))
    print("same room, two photos:", json.dumps([(x["kind"], x["distance"]) for x in rep["same_room_pairs"]]))
    if a.out:
        Path(a.out).write_text(json.dumps(rep, indent=1), "utf-8")
    return 0


if __name__ == "__main__":
    sys.exit(main())
