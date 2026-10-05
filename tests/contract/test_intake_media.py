"""Phase 4 contract tests: listing drafts, presigned uploads through the proxy, the photo intake job.

Photos are generated here (no real photo). Object storage is Garage on the compose stack and an
S3 stand-in in the sandbox; the Media service is real in both.
"""
import io
import os
import time
import uuid
from urllib.parse import urlsplit, urlunsplit

import random

import httpx
import pytest
from PIL import Image, ImageDraw

from conftest import assert_error, assert_ok, sandbox_only
from test_profile_search import make_user, wait_job

MEDIA = ("terms", "privacy", "media_processing")


def photo(seed=1, w=900, h=700, gps=True, text=None, resize=None):
    rng = random.Random(seed)
    g = Image.linear_gradient("L")
    img = Image.merge("RGB", (g.rotate(90).resize((w, h)), g.resize((w, h)), g.rotate(45).resize((w, h))))
    d = ImageDraw.Draw(img)
    for _ in range(14):
        x0, y0 = rng.randrange(0, w - 120), rng.randrange(0, h - 120)
        d.rectangle([x0, y0, x0 + rng.randrange(40, 220), y0 + rng.randrange(40, 220)], fill=tuple(rng.randrange(0, 255) for _ in range(3)))
    if text:
        d.rectangle([40, 40, 860, 140], fill=(240, 240, 240))
        d.text((60, 70), text, fill=(10, 10, 10))
    ex = Image.Exif()
    ex[0x010F] = "TestPhone"
    if gps:
        g = ex.get_ifd(0x8825)
        g[1], g[2], g[3], g[4] = "N", (36.0, 0.0, 30.0), "E", (10.0, 0.0, 10.0)
    if resize:
        img = img.resize(resize)
    b = io.BytesIO()
    img.save(b, "JPEG", quality=90 if not resize else 70, exif=ex.tobytes())
    return b.getvalue()


def put_upload(u, data):
    """PUT to a presigned URL. The URL names the public proxy host; inside the tests container the proxy has
    another name (FS_API_BASE), so the request goes there with the signed Host header unchanged."""
    parts = urlsplit(u["url"])
    base = urlsplit(os.environ.get("FS_API_BASE", "http://127.0.0.1:8080"))
    target = urlunsplit((base.scheme, base.netloc, parts.path, parts.query, ""))
    return httpx.put(target, content=data, headers={**u["headers"], "Host": parts.netloc}, timeout=30)


@pytest.fixture(scope="module")
def owner():
    import psycopg
    db = psycopg.connect(os.environ["FS_TEST_DB_DSN"], autocommit=True)
    db.execute("""insert into app.jurisdictions (code, country_code, name, default_currency, default_locale, languages, timezone, rules)
                  values ('QX', 'QX', 'Test jurisdiction (tests only)', 'TND', 'fr-TN', '{fr,ar}', 'Africa/Tunis',
                          '{"allowed_preference_filters": ["smoking"]}') on conflict (code) do nothing""")
    yield {"owner": make_user(db, "owner", MEDIA), "other": make_user(db, "owner", MEDIA),
           "no_media": make_user(db, "owner", ("terms", "privacy"))}
    # many requests from one address within a minute: clear the per-address counters for the next modules (F-045)
    db.execute("delete from app.rate_counters where bucket like 'ip:%'")
    db.close()


def create(client, uid, idem, **body):
    return client.call("POST", "/v1/listings", body={"text": "Chambre meublée à Testville, 450 DT, libre en novembre",
                                                     "jurisdiction_code": "qx", **body}, user_id=uid, idem=idem())


def test_create_listing_and_validation(client, owner, idem, db):
    j = assert_ok(create(client, owner["owner"], idem, title="Chambre"), 201, "ListingCreatedResponse")
    row = db.execute("select status, jurisdiction_code, description, owner_id::text from app.listings where id = %s",
                     (j["data"]["listing_id"],)).fetchone()
    assert row == ("draft", "QX", "Chambre meublée à Testville, 450 DT, libre en novembre", owner["owner"])
    r = client.call("POST", "/v1/listings", body={"text": "", "jurisdiction_code": "QX", "x": 1}, user_id=owner["owner"], idem=idem())
    j = assert_error(r, 422, "VALIDATION_FAILED")
    assert {d["field"] for d in j["error"]["details"]} >= {"text", "x"}
    assert_error(client.call("POST", "/v1/listings", body={"text": "a", "jurisdiction_code": "ZZ"}, user_id=owner["owner"], idem=idem()),
                 422, "VALIDATION_FAILED")


def test_presign_rules(client, owner, idem):
    lid = create(client, owner["owner"], idem).json()["data"]["listing_id"]
    url = f"/v1/listings/{lid}/media/presign"
    one = {"files": [{"kind": "photo", "content_type": "image/jpeg", "bytes": 120000}]}
    assert_error(client.call("POST", url, body=one, user_id=owner["no_media"], idem=idem()), 403, "CONSENT_REQUIRED")
    assert_error(client.call("POST", url, body=one, user_id=owner["other"], idem=idem()), 404, "NOT_FOUND")
    assert_error(client.call("POST", f"/v1/listings/{uuid.uuid4()}/media/presign", body=one, user_id=owner["owner"], idem=idem()),
                 404, "NOT_FOUND")
    j = assert_error(client.call("POST", url, body={"files": [{"kind": "photo", "content_type": "image/gif", "bytes": 10},
                                                              {"kind": "photo", "content_type": "image/jpeg", "bytes": 99_000_000}]},
                                 user_id=owner["owner"], idem=idem()), 422, "VALIDATION_FAILED")
    assert [d["issue"] for d in j["error"]["details"]] == ["not_accepted", "too_large"]
    j = assert_ok(client.call("POST", url, body=one, user_id=owner["owner"], idem=idem()), 200, "PresignResponse")
    u = j["data"]["uploads"][0]
    assert u["method"] == "PUT" and "X-Amz-Signature=" in u["url"] and f"/uploads/{lid}/" in u["url"]
    assert_error(client.call("POST", f"/v1/listings/{lid}/analyze", body={}, user_id=owner["other"], idem=idem()), 404, "NOT_FOUND")


def test_upload_route_only_takes_signed_puts(client, owner, idem):
    lid = create(client, owner["owner"], idem).json()["data"]["listing_id"]
    u = client.call("POST", f"/v1/listings/{lid}/media/presign", body={"files": [{"kind": "photo", "content_type": "image/jpeg", "bytes": 1000}]},
                    user_id=owner["owner"], idem=idem()).json()["data"]["uploads"][0]
    parts = urlsplit(u["url"])
    base = os.environ.get("FS_API_BASE", "http://127.0.0.1:8080")
    assert httpx.get(base + parts.path + "?" + parts.query, timeout=10).status_code == 404       # no GET through the proxy
    assert httpx.put(base + parts.path, content=b"x", timeout=10).status_code == 404               # unsigned: not routed


def test_photo_intake_end_to_end(client, owner, idem, db):
    lid = create(client, owner["owner"], idem).json()["data"]["listing_id"]
    db.execute("update app.listings set location = st_setsrid(st_makepoint(10.0028, 36.0083), 4326)::geography where id = %s", (lid,))
    files = [{"kind": "photo", "content_type": "image/jpeg", "bytes": 300000}] * 3
    ups = assert_ok(client.call("POST", f"/v1/listings/{lid}/media/presign", body={"files": files}, user_id=owner["owner"], idem=idem()),
                    200, "PresignResponse")["data"]["uploads"]
    good, fake, never = ups
    assert put_upload(good, photo(1, text="Contract signed by the owner")).status_code == 200
    assert put_upload(fake, b"this is not an image " * 100).status_code == 200
    # the third slot is never uploaded: it stays pending
    r = client.call("POST", f"/v1/listings/{lid}/analyze", body={}, user_id=owner["owner"], idem=idem())
    job = wait_job(client, owner["owner"], assert_ok(r, 202, "JobAcceptedResponse")["data"]["status_url"])
    assert job["status"] == "succeeded", job
    out = job["output"]
    assert (out["processed"], out["rejected"], out["missing"], out["transient"]) == (1, 1, 1, 0), out
    assert out["raw_deleted"] == 2
    v = assert_ok(client.call("GET", f"/v1/listings/{lid}", user_id=owner["owner"]), 200, "ListingResponse")["data"]
    assert len(v["media"]) == 1
    m = v["media"][0]
    assert m["analysis"]["exif"]["has_gps"] is True and m["analysis"]["exif"]["gps_distance_m"] in (0, 100)
    assert "gps" not in m["analysis"]["exif"] and m["analysis"]["blur"]["counts"]["text"] >= 1 and m["moderation"] == "blurred"
    assert {u["upload_id"]: u["status"] for u in v["uploads"]} == {fake["upload_id"]: "rejected", never["upload_id"]: "pending"}
    assert [u["error_code"] for u in v["uploads"] if u["upload_id"] == fake["upload_id"]] == ["UNSUPPORTED_TYPE"]
    key = db.execute("select storage_key from app.listing_media where listing_id = %s", (lid,)).fetchone()[0]
    assert key == f"media/{lid}/{good['upload_id']}.jpg"
    assert_error(client.call("GET", f"/v1/listings/{lid}", user_id=owner["other"]), 404, "NOT_FOUND")
    # the same picture, resized and recompressed, in another owner's listing is found as a near duplicate
    lid2 = create(client, owner["other"], idem).json()["data"]["listing_id"]
    u2 = client.call("POST", f"/v1/listings/{lid2}/media/presign", body={"files": files[:1]}, user_id=owner["other"],
                     idem=idem()).json()["data"]["uploads"][0]
    assert put_upload(u2, photo(1, gps=False, text="Contract signed by the owner", resize=(800, 622))).status_code == 200
    r = client.call("POST", f"/v1/listings/{lid2}/analyze", body={}, user_id=owner["other"], idem=idem())
    job2 = wait_job(client, owner["other"], r.json()["data"]["status_url"])
    f = job2["output"]["files"][0]
    mine = [d for d in f["near_duplicates"] if d["listing_id"] == lid]          # earlier runs may add more matches
    assert f["status"] == "processed" and mine and mine[0]["same_owner"] is False and mine[0]["distance"] <= 6


def test_analyze_needs_text_or_files(client, owner, idem, db):
    """Phase 4.4: a listing with text and no file can be analyzed (the text extraction runs); with neither, 422."""
    lid = create(client, owner["owner"], idem).json()["data"]["listing_id"]
    assert_ok(client.call("POST", f"/v1/listings/{lid}/analyze", body={}, user_id=owner["owner"], idem=idem()), 202, "JobAcceptedResponse")
    lid = create(client, owner["owner"], idem).json()["data"]["listing_id"]
    db.execute("update app.listings set description = ' ' where id = %s", (lid,))   # the API never creates an empty text
    j = assert_error(client.call("POST", f"/v1/listings/{lid}/analyze", body={}, user_id=owner["owner"], idem=idem()), 422, "VALIDATION_FAILED")
    assert j["error"]["details"][0]["issue"] == "none_pending"


@sandbox_only
def test_media_service_down_job_is_retried(client, owner, idem, db):
    """Transient failure (spec 5.6): the job goes back to the queue with a retry time, the file stays pending."""
    import subprocess
    lid = create(client, owner["owner"], idem).json()["data"]["listing_id"]
    u = client.call("POST", f"/v1/listings/{lid}/media/presign", body={"files": [{"kind": "photo", "content_type": "image/jpeg", "bytes": 1000}]},
                    user_id=owner["owner"], idem=idem()).json()["data"]["uploads"][0]
    assert put_upload(u, photo(5)).status_code == 200
    subprocess.run(["/opt/lab/services.sh", "stop-one", "media"], check=False)
    try:
        r = client.call("POST", f"/v1/listings/{lid}/analyze", body={}, user_id=owner["owner"], idem=idem())
        jid = r.json()["data"]["job_id"]
        for _ in range(60):
            row = db.execute("select status, attempts, next_attempt_at, last_error from app.jobs where id = %s", (jid,)).fetchone()
            if row[0] == "queued" and row[1] == 1:
                break
            time.sleep(1)
        assert row[0] == "queued" and row[1] == 1 and row[2] is not None and "not processed" in row[3], row
        st = db.execute("select status from app.media_uploads where id = %s", (u["upload_id"],)).fetchone()[0]
        assert st == "pending"
    finally:
        subprocess.run(["/opt/lab/services.sh", "start", "media"], check=False)
    db.execute("update app.jobs set next_attempt_at = now() where id = %s", (jid,))
    deadline = time.time() + 150                      # wf.jobs.dispatch runs every minute
    while time.time() < deadline:
        row = db.execute("select status, attempts, output from app.jobs where id = %s", (jid,)).fetchone()
        if row[0] == "succeeded":
            break
        time.sleep(3)
    assert row[0] == "succeeded" and row[1] == 2 and row[2]["processed"] == 1, row
