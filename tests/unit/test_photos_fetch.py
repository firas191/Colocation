"""scripts/photos.py fetch: licence filter, manifest fields, no network (MockTransport)."""
import argparse
import importlib.util
import io
import json
from pathlib import Path

import httpx
from PIL import Image

spec = importlib.util.spec_from_file_location("photos", Path(__file__).resolve().parents[2] / "scripts" / "photos.py")
photos = importlib.util.module_from_spec(spec)
spec.loader.exec_module(photos)


def jpeg(w=900, h=700):
    b = io.BytesIO()
    Image.new("RGB", (w, h), (200, 180, 160)).save(b, "JPEG")
    return b.getvalue()


def page(i, lic, short, mime="image/jpeg", w=2000, h=1500):
    return {"index": i, "title": f"File:Room {i}.jpg", "imageinfo": [{
        "mime": mime, "width": w, "height": h, "url": f"https://upload.test/{i}.jpg", "thumburl": f"https://upload.test/t{i}.jpg",
        "descriptionurl": f"https://commons.test/File:Room_{i}.jpg",
        "extmetadata": {"License": {"value": lic}, "LicenseShortName": {"value": short},
                        "Artist": {"value": "<a href='x'>Jane &amp; Co</a>"}, "LicenseUrl": {"value": "https://cc.test"}}}]}


def test_licence_filter():
    assert photos.licence_ok({"License": {"value": "cc-by-sa-4.0"}})[0]
    assert photos.licence_ok({"License": {"value": "cc0"}})[0]
    assert photos.licence_ok({"LicenseShortName": {"value": "Public domain"}})[0]
    assert photos.licence_ok({"LicenseShortName": {"value": "CC BY 2.0"}})[0]
    assert not photos.licence_ok({"License": {"value": "cc-by-nc-sa-2.0"}, "LicenseShortName": {"value": "CC BY-NC-SA 2.0"}})[0]
    assert not photos.licence_ok({"LicenseShortName": {"value": "GFDL"}})[0]
    assert not photos.licence_ok({})[0]


def test_fetch_keeps_only_allowed_files_and_records_the_source(tmp_path, monkeypatch):
    monkeypatch.setattr(photos, "QUERIES", [("bedroom", "bedroom")])
    pages = [page(1, "cc-by-sa-4.0", "CC BY-SA 4.0"), page(2, "cc-by-nc-2.0", "CC BY-NC 2.0"),
             page(3, "cc0", "CC0", mime="image/gif"), page(4, "pd", "Public domain", w=500, h=400), page(5, "cc-by-2.0", "CC BY 2.0")]
    seen = []

    def handler(req: httpx.Request):
        seen.append(req)
        if req.url.path.endswith("api.php"):
            assert "filetype:bitmap" in req.url.params["gsrsearch"]
            return httpx.Response(200, json={"query": {"pages": pages}})
        return httpx.Response(200, content=jpeg())
    args = argparse.Namespace(out=str(tmp_path), per_query=10, search_limit=40, pause=0)
    assert photos.fetch(args, httpx.Client(transport=httpx.MockTransport(handler))) == 0
    m = json.loads((tmp_path / "manifest.json").read_text())
    assert [x["title"] for x in m["items"]] == ["File:Room 1.jpg", "File:Room 5.jpg"]
    x = m["items"][0]
    assert x["licence"] == "CC BY-SA 4.0" and x["author"] == "Jane & Co" and x["source_page"].endswith("Room_1.jpg")
    assert (tmp_path / "images" / x["file"]).exists() and len(x["sha256"]) == 64
    # a second run adds nothing it already has
    assert photos.fetch(args, httpx.Client(transport=httpx.MockTransport(handler))) == 0
    assert len(json.loads((tmp_path / "manifest.json").read_text())["items"]) == 2
