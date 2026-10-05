"""Media service over HTTP (spec 15.1 'Service' layer): token, validation, storage round trip with presigned upload.
Object storage is an in-process S3 server (moto) here; on the compose stack it is Garage (tests/contract)."""
import importlib
import io
import os

import httpx
import pytest
from fastapi.testclient import TestClient
from PIL import Image

from test_imaging import exif_bytes, jpeg, scene

TOKEN = "t" * 32


@pytest.fixture(scope="module")
def s3():
    from moto.server import ThreadedMotoServer
    server = ThreadedMotoServer(ip_address="127.0.0.1", port=0)
    server.start()
    host, port = server.get_host_and_port()
    url = f"http://{host}:{port}"
    os.environ.update({"S3_ENDPOINT": url, "S3_PUBLIC_ENDPOINT": url, "S3_ACCESS_KEY_ID": "test", "S3_SECRET_ACCESS_KEY": "test",
                       "S3_BUCKET": "media-test", "S3_REGION": "us-east-1", "INTERNAL_SERVICE_TOKEN": TOKEN,
                       "MEDIA_WARM_DETECTORS": "0"})
    import storage
    storage.internal.cache_clear()
    storage.public.cache_clear()
    storage.internal().create_bucket(Bucket="media-test")
    yield storage
    server.stop()


@pytest.fixture(scope="module")
def client(s3):
    import app as media_app
    importlib.reload(media_app)
    return TestClient(media_app.app)


H = {"X-Internal-Token": TOKEN}


def test_token_required_except_health(client):
    assert client.get("/health").status_code == 200
    r = client.post("/v1/storage/presign", json={"key": "a/b.jpg", "content_type": "image/jpeg"})
    assert r.status_code == 401 and r.json()["error"]["code"] == "UNAUTHENTICATED"
    r = client.post("/v1/storage/presign", json={"key": "a/b.jpg", "content_type": "image/jpeg"}, headers={"X-Internal-Token": "x" * 32})
    assert r.status_code == 401


@pytest.mark.parametrize("body,field", [
    ({"key": "../etc/passwd", "content_type": "image/jpeg"}, "key"),
    ({"key": "Upper/Case.jpg", "content_type": "image/jpeg"}, "key"),
    ({"key": "a/b.exe", "content_type": "application/x-msdownload"}, "content_type"),
    ({"key": "a/b.jpg", "content_type": "image/jpeg", "expires_s": 86400}, "expires_s"),
    ({"key": "a/b.jpg", "content_type": "image/jpeg", "extra": 1}, "extra"),
])
def test_presign_validation(client, body, field):
    r = client.post("/v1/storage/presign", json=body, headers=H)
    assert r.status_code == 422 and r.json()["error"]["code"] == "VALIDATION_FAILED"
    assert any(d["field"] == field for d in r.json()["error"]["details"])


def test_presigned_upload_then_process(client, s3):
    r = client.post("/v1/storage/presign", json={"key": "uploads/l1/p1.jpg", "content_type": "image/jpeg"}, headers=H)
    assert r.status_code == 200
    up = r.json()
    data = jpeg(scene(12), exif=exif_bytes())
    put = httpx.put(up["url"], content=data, headers=up["headers"], timeout=10)
    assert put.status_code == 200, put.text
    # (that Garage refuses a different Content-Type than the signed one is checked in tests/contract;
    # the in-process S3 server used here does not verify signatures)
    r = client.post("/v1/images/process", json={"source_key": "uploads/l1/p1.jpg", "output_key": "media/l1/p1.jpg", "blur": False}, headers=H)
    assert r.status_code == 200, r.text
    j = r.json()
    assert j["exif"]["has_gps"] and j["width"] == 800 and j["output"]["key"] == "media/l1/p1.jpg"
    stored = s3.internal().get_object(Bucket="media-test", Key="media/l1/p1.jpg")["Body"].read()
    assert len(Image.open(io.BytesIO(stored)).getexif()) == 0 and b"PhoneMaker" not in stored
    h = client.post("/v1/storage/head", json={"keys": ["media/l1/p1.jpg", "media/l1/none.jpg"]}, headers=H).json()
    assert [o["exists"] for o in h["objects"]] == [True, False]


def test_process_errors(client, s3):
    r = client.post("/v1/images/process", json={"source_key": "uploads/none.jpg", "output_key": "media/x.jpg"}, headers=H)
    assert r.status_code == 404 and r.json()["error"]["code"] == "NOT_FOUND"
    s3.put("uploads/fake.jpg", b"not an image" * 50, "image/jpeg")
    r = client.post("/v1/images/process", json={"source_key": "uploads/fake.jpg", "output_key": "media/x.jpg"}, headers=H)
    assert r.status_code == 422 and r.json()["error"]["details"][0]["issue"] == "UNSUPPORTED_TYPE"
    s3.put("uploads/big.jpg", jpeg(scene(13)), "image/jpeg")
    r = client.post("/v1/images/process", json={"source_key": "uploads/big.jpg", "output_key": "media/x.jpg", "max_bytes": 100}, headers=H)
    assert r.status_code == 422 and r.json()["error"]["details"][0]["issue"] == "TOO_LARGE"


def test_delete(client, s3):
    s3.put("uploads/del.jpg", b"x", "image/jpeg")
    assert client.post("/v1/storage/delete", json={"keys": ["uploads/del.jpg"]}, headers=H).json() == {"deleted": 1}
    h = client.post("/v1/storage/head", json={"keys": ["uploads/del.jpg"]}, headers=H).json()
    assert h["objects"][0]["exists"] is False


@pytest.mark.skipif(not (os.path.isdir(os.environ.get("MEDIA_MODEL_DIR", "models"))), reason="detector models not present")
def test_detectors_find_synthetic_text(client):
    import numpy as np
    import cv2
    from detectors import Detectors
    img = np.full((900, 1200, 3), 235, np.uint8)
    cv2.putText(img, "Lease agreement - rent 450 TND", (60, 200), cv2.FONT_HERSHEY_SIMPLEX, 1.6, (20, 20, 20), 3)
    boxes = Detectors().texts(img)
    assert boxes and all(b.kind == "text" for b in boxes)
    assert any(b.y < 200 < b.y + b.h + 10 and b.x < 100 for b in boxes)


def test_vision_copy_of_a_stored_photo(client, s3):
    """D-081: the vision model gets a smaller JPEG of the processed copy, as base64."""
    import base64
    s3.put("media/l2/p1.jpg", jpeg(scene(w=2000, h=1500)), "image/jpeg")
    r = client.post("/v1/images/vision", json={"key": "media/l2/p1.jpg", "max_side": 512}, headers=H)
    assert r.status_code == 200, r.text
    j = r.json()
    img = Image.open(io.BytesIO(base64.b64decode(j["image_b64"])))
    assert img.format == "JPEG" and max(img.size) == 512 and (j["width"], j["height"]) == img.size == (512, 384)
    assert client.post("/v1/images/vision", json={"key": "media/none.jpg"}, headers=H).status_code == 404
    assert client.post("/v1/images/vision", json={"key": "media/l2/p1.jpg", "max_side": 10}, headers=H).status_code == 422
    s3.put("media/l2/fake.jpg", b"not an image at all, just text" * 10, "image/jpeg")
    r = client.post("/v1/images/vision", json={"key": "media/l2/fake.jpg"}, headers=H)
    assert r.status_code == 422 and r.json()["error"]["details"][0]["issue"] == "UNSUPPORTED_TYPE"


def test_eval_photos_are_processed_and_stored_under_eval_only(client, s3):
    import base64
    b64 = base64.b64encode(jpeg(scene(), exif=exif_bytes())).decode()
    r = client.post("/v1/eval/photos", json={"key": "eval/p7/a.jpg", "image_b64": b64, "blur": False}, headers=H)
    assert r.status_code == 200, r.text
    assert r.json()["blur"]["detectors"] is False and len(r.json()["phash"]) == 16
    stored = Image.open(io.BytesIO(s3.get("eval/p7/a.jpg", 10_000_000)))
    assert not stored.getexif()                                   # EXIF stripped as for listing photos
    r = client.post("/v1/eval/photos", json={"key": "media/l1/x.jpg", "image_b64": b64}, headers=H)
    assert r.status_code == 422 and r.json()["error"]["details"][0]["field"] == "key"
    r = client.post("/v1/eval/photos", json={"key": "eval/p7/b.jpg", "image_b64": "@" * 200}, headers=H)
    assert r.status_code == 422 and r.json()["error"]["details"][0]["field"] == "image_b64"
