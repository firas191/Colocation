"""Photo set for P7 and the duplicate-photo threshold (D-069), kept outside the repository.

  python scripts/photos.py fetch --out /photo_bench      # candidates from Wikimedia Commons, with licence and author
  python scripts/photos.py upload --dir /photo_bench     # labelled photos (eval/datasets/p7_photos_v1.jsonl) through the
                                                         # Media service into object storage under eval/p7/ (D-082)

Runs on the owner's PC (Wikimedia is not reachable from the sandbox), inside the tests container with the photo folder
mounted at /photo_bench. Only files under CC0, public domain, CC BY or CC BY-SA are kept; for each one the manifest records
the source page, author, licence and the SHA-256 of the downloaded copy. The images stay in the photo folder (not committed);
the labels and the manifest without images are committed later (eval/datasets).
"""
import argparse
import hashlib
import html
import io
import json
import os
import re
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

import httpx
from PIL import Image

API = "https://commons.wikimedia.org/w/api.php"
# Wikimedia asks every client for a descriptive User-Agent (https://meta.wikimedia.org/wiki/User-Agent_policy).
UA = "FlatshareEval/0.1 (university project; room photo test set; httpx)" + (
    f" contact: {os.environ['WIKIMEDIA_CONTACT']}" if os.environ.get("WIKIMEDIA_CONTACT") else "")

# (group, search text). Groups are only a spread for the search; the labels come from looking at each photo.
QUERIES = [
    ("bedroom", "bedroom apartment interior"),
    ("bedroom", "student room dormitory"),
    ("bedroom", "hostel room bunk beds"),
    ("bedroom", "guest room bed interior"),
    ("kitchen", "apartment kitchen interior"),
    ("kitchen", "small kitchen flat"),
    ("living", "living room apartment interior"),
    ("living", "salon appartement"),
    ("bathroom", "bathroom interior apartment"),
    ("other", "studio apartment interior"),
    ("other", "apartment hallway corridor interior"),
    ("other", "apartment balcony"),
    ("negative", "apartment building facade"),
    ("negative", "apartment floor plan"),
]
ALLOWED = re.compile(r"^(cc0|pd|public domain|cc-by-(sa-)?\d(\.\d)?|cc by( |-)(sa )?\d(\.\d)?)$", re.I)


def plain(v: str | None) -> str:
    return re.sub(r"\s+", " ", html.unescape(re.sub(r"<[^>]+>", " ", v or ""))).strip()


def licence_ok(meta: dict) -> tuple[bool, str, str]:
    lic = plain((meta.get("License") or {}).get("value"))
    short = plain((meta.get("LicenseShortName") or {}).get("value"))
    ok = any(ALLOWED.match(x) for x in (lic, short) if x)
    return ok, lic, short


def search(c: httpx.Client, text: str, limit: int) -> list[dict]:
    params = {"action": "query", "format": "json", "formatversion": "2", "generator": "search",
              "gsrsearch": f"{text} filetype:bitmap", "gsrnamespace": "6", "gsrlimit": str(limit),
              "prop": "imageinfo", "iiprop": "url|size|mime|extmetadata", "iiurlwidth": "1280"}
    r = c.get(API, params=params, timeout=60)
    r.raise_for_status()
    pages = r.json().get("query", {}).get("pages", [])
    return sorted(pages, key=lambda p: p.get("index", 0))


def fetch(args, client: httpx.Client | None = None) -> int:
    out = Path(args.out)
    (out / "images").mkdir(parents=True, exist_ok=True)
    man_path = out / "manifest.json"
    manifest = json.loads(man_path.read_text("utf-8")) if man_path.exists() else {"items": []}
    have = {x["title"] for x in manifest["items"]}
    skipped = {"licence": 0, "type": 0, "small": 0, "seen": 0, "error": 0}
    with (client or httpx.Client(headers={"User-Agent": UA}, follow_redirects=True)) as c:
        for group, text in QUERIES:
            kept = 0
            try:
                pages = search(c, text, args.search_limit)
            except httpx.HTTPError as e:
                print(f"search failed for '{text}': {type(e).__name__}", flush=True)
                skipped["error"] += 1
                continue
            for p in pages:
                if kept >= args.per_query:
                    break
                ii = (p.get("imageinfo") or [{}])[0]
                meta = ii.get("extmetadata") or {}
                if p["title"] in have:
                    skipped["seen"] += 1
                    continue
                if ii.get("mime") not in ("image/jpeg", "image/png"):
                    skipped["type"] += 1
                    continue
                if min(ii.get("width", 0), ii.get("height", 0)) < 600:
                    skipped["small"] += 1
                    continue
                ok, lic, short = licence_ok(meta)
                if not ok:
                    skipped["licence"] += 1
                    continue
                try:
                    r = c.get(ii.get("thumburl") or ii["url"], timeout=60)
                    r.raise_for_status()
                    im = Image.open(io.BytesIO(r.content))
                    im.load()
                except Exception as e:  # noqa: BLE001
                    print(f"download failed for {p['title']}: {type(e).__name__}", flush=True)
                    skipped["error"] += 1
                    continue
                sha = hashlib.sha256(r.content).hexdigest()
                name = f"c-{sha[:12]}.{'png' if im.format == 'PNG' else 'jpg'}"
                (out / "images" / name).write_bytes(r.content)
                manifest["items"].append({
                    "file": name, "sha256": sha, "title": p["title"], "group": group, "query": text,
                    "source_page": ii.get("descriptionurl"), "source_file": ii.get("url"), "downloaded_url": str(r.url),
                    "licence": short or lic, "licence_code": lic, "licence_url": plain((meta.get("LicenseUrl") or {}).get("value")),
                    "author": plain((meta.get("Artist") or {}).get("value"))[:300],
                    "credit": plain((meta.get("Credit") or {}).get("value"))[:300],
                    "width": im.width, "height": im.height, "fetched_at": datetime.now(timezone.utc).isoformat()})
                have.add(p["title"])
                kept += 1
                time.sleep(args.pause)
            print(f"{group:9} {text:40} kept {kept}", flush=True)
            man_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=1), "utf-8")
    print(f"manifest: {len(manifest['items'])} photos; skipped {skipped}", flush=True)
    return 0 if manifest["items"] else 1


ROOT = Path(__file__).resolve().parents[1]


def dataset_rows(name: str = "p7_photos_v1.jsonl") -> list[dict]:
    path = ROOT / "eval" / "datasets" / name
    return [json.loads(l) for l in path.read_text("utf-8").splitlines() if l.strip()]


def upload(args, client: httpx.Client | None = None) -> int:
    """Each labelled photo goes through the Media service's own processing (type check, EXIF strip, blurring), like a
    listing photo, and is stored as eval/p7/<id>.jpg; P7 then reads it exactly as it reads listing photos."""
    import base64
    rows = dataset_rows(args.dataset)
    token = os.environ.get("INTERNAL_SERVICE_TOKEN", "")
    if len(token) < 16:
        print("INTERNAL_SERVICE_TOKEN is not set", flush=True)
        return 1
    report, bad = [], 0
    with (client or httpx.Client(timeout=120)) as c:
        for r in rows:
            f = Path(args.dir) / "images" / r["file"]
            if not f.exists():
                print(f"{r['id']}: {r['file']} not in {args.dir}/images", flush=True)
                bad += 1
                continue
            data = f.read_bytes()
            if hashlib.sha256(data).hexdigest() != r["sha256"]:
                print(f"{r['id']}: {r['file']} differs from the labelled file (sha256)", flush=True)
                bad += 1
                continue
            im = Image.open(io.BytesIO(data)).convert("RGB")
            if max(im.size) > 1600:                         # keeps the request under the service's 2 MiB body limit
                im.thumbnail((1600, 1600), Image.Resampling.LANCZOS)
            buf = io.BytesIO()
            im.save(buf, "JPEG", quality=90)
            resp = c.post(f"{args.media_url.rstrip('/')}/v1/eval/photos", headers={"X-Internal-Token": token},
                          json={"key": f"eval/p7/{r['id']}.jpg", "image_b64": base64.b64encode(buf.getvalue()).decode(), "blur": True})
            if resp.status_code != 200:
                print(f"{r['id']}: media service answered {resp.status_code}: {resp.text[:200]}", flush=True)
                bad += 1
                continue
            j = resp.json()
            report.append({"id": r["id"], "key": j["key"], "blur": j["blur"]["counts"], "width": j["width"], "height": j["height"]})
    blurred = sum(1 for x in report if sum(x["blur"].values()))
    print(f"uploaded {len(report)} of {len(rows)} photos; {blurred} with something blurred; {bad} problems", flush=True)
    if args.report:
        Path(args.report).write_text(json.dumps(report, indent=1), "utf-8")
    return 0 if not bad else 1


def main() -> int:
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    f = sub.add_parser("fetch")
    f.add_argument("--out", default="/photo_bench")
    f.add_argument("--per-query", type=int, default=10)
    f.add_argument("--search-limit", type=int, default=40)
    f.add_argument("--pause", type=float, default=0.5)
    u = sub.add_parser("upload")
    u.add_argument("--dir", default="/photo_bench")
    u.add_argument("--dataset", default="p7_photos_v1.jsonl")
    u.add_argument("--media-url", default=os.environ.get("MEDIA_URL", "http://media:8000"))
    u.add_argument("--report", default=None)
    a = ap.parse_args()
    return {"fetch": fetch, "upload": upload}[a.cmd](a)


if __name__ == "__main__":
    sys.exit(main())
