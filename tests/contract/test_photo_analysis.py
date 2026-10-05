"""Phase 4 P7: photo analysis inside the listing analysis job (spec 11.2 steps 5 and 6, D-081).

Sandbox only: the model is the Ollama mock, which cannot see; it picks its answer from the photo's mean colour
(tests/mocks/deps_mock.py p7_answer). These tests check the plumbing, the checks and what is stored, not the model.
"""
import io

import pytest
from PIL import Image

from conftest import assert_ok, sandbox_only
from test_intake_media import create, owner, photo, put_upload  # noqa: F401  (module fixture reused)
from test_profile_search import wait_job

pytestmark = sandbox_only


def plain(rgb, w=900, h=700):
    b = io.BytesIO()
    Image.new("RGB", (w, h), rgb).save(b, "JPEG", quality=90)
    return b.getvalue()


def analyze_with(client, uid, idem, images, text="Chambre meublée à Testville, 450 DT, libre en novembre"):
    lid = create(client, uid, idem, text=text).json()["data"]["listing_id"]
    files = [{"kind": "photo", "content_type": "image/jpeg", "bytes": 300000}] * len(images)
    ups = assert_ok(client.call("POST", f"/v1/listings/{lid}/media/presign", body={"files": files}, user_id=uid, idem=idem()),
                    200, "PresignResponse")["data"]["uploads"]
    for u, data in zip(ups, images):
        assert put_upload(u, data).status_code == 200
    r = client.call("POST", f"/v1/listings/{lid}/analyze", body={}, user_id=uid, idem=idem())
    job = wait_job(client, uid, assert_ok(r, 202, "JobAcceptedResponse")["data"]["status_url"])
    view = assert_ok(client.call("GET", f"/v1/listings/{lid}", user_id=uid), 200, "ListingResponse")["data"]
    return lid, job, view


def test_photo_is_analyzed_and_compared_with_the_text(client, owner, idem, db):  # noqa: F811
    lid, job, v = analyze_with(client, owner["owner"], idem, [photo(11, gps=False)])
    assert job["status"] == "succeeded", job
    f = job["output"]["files"][0]
    assert f["status"] == "processed" and f["vision"] == {"status": "analyzed", "room_type": "bedroom", "flags": [], "error_code": None}
    a = v["media"][0]["analysis"]["vision"]
    assert a["status"] == "analyzed" and a["fields"]["room_type"] == "bedroom" and a["fields"]["furniture"] == ["wardrobe", "desk"]
    assert a["fields"]["appliances"] == ["tv", "air_conditioning"] and a["version"] == 1 and a["prompt_version_id"]
    assert a["description"].startswith("A bright bedroom") and a["dropped"] == [] and a["model_output"]["room_type"] == "bedroom"
    # the photo shows a TV, air conditioning and a desk that the text does not mention; the text says furnished, so does the photo
    ex = v["extraction"]
    assert "photos_show_amenities_not_in_text" in ex["issues"] and "photos_contradict_furnished" not in ex["issues"]
    assert ex["photos"] == {"analyzed": 1, "failed": 0, "amenities_seen_not_in_text": ["air_conditioning", "desk", "tv"]}
    assert v["amenities"] == []                                   # suggestions only: the owner confirms (D-081)
    row = db.execute("""select s.agent, s.prompt_version_id is not null, s.input::text, e.status from ai.executions e
                        join ai.agent_steps s on s.execution_id = e.id
                        where e.request_id = %s and e.workflow = 'wf.intake.photos'""", (job["job_id"],)).fetchone()
    assert row[0] == "A1_photo" and row[1] is True and row[3] == "succeeded" and "base64" not in row[2] and len(row[2]) < 200


def test_free_text_about_a_person_is_not_stored(client, owner, idem):  # noqa: F811
    """Spec 11.2: describe the room only. The mock describes a person; the checks drop that text and keep a flag."""
    lid, job, v = analyze_with(client, owner["owner"], idem, [plain((200, 40, 40))])
    a = v["media"][0]["analysis"]["vision"]
    assert a["status"] == "analyzed" and a["fields"]["people_visible"] is True and "person_in_photo" in a["flags"]
    assert "description" not in a and a["dropped"] == ["description_about_people"] and a["model_output"] is None
    assert "woman" not in str(v).lower()


def test_failed_analysis_keeps_the_photo_and_flags_the_listing(client, owner, idem):  # noqa: F811
    """Spec 8.4 A1: a vision failure sends the listing to review with a note; the photo itself is kept."""
    lid, job, v = analyze_with(client, owner["owner"], idem, [plain((40, 200, 40))])
    assert job["status"] == "succeeded" and job["output"]["files"][0]["status"] == "processed"
    assert job["output"]["files"][0]["vision"]["status"] == "failed"
    a = v["media"][0]["analysis"]["vision"]
    assert a["status"] == "failed" and a["error_code"] == "invalid_json" and "fields" not in a
    assert "photo_analysis_failed" in v["extraction"]["issues"] and v["extraction"]["photos"]["failed"] == 1


def test_vision_can_be_switched_off(client, owner, idem, db):  # noqa: F811
    db.execute("update app.settings set value = 'false' where key = 'vision.enabled'")
    try:
        lid, job, v = analyze_with(client, owner["owner"], idem, [photo(12, gps=False)])
    finally:
        db.execute("update app.settings set value = 'true' where key = 'vision.enabled'")
    assert job["output"]["files"][0]["vision"] == {"status": "skipped"} and "vision" not in v["media"][0]["analysis"]
    assert v["extraction"]["photos"] == {"analyzed": 0, "failed": 0, "amenities_seen_not_in_text": []}


def test_p7_eval_run_scores_both_versions(client, db):
    """D-082: golden-set run of P7 over photos stored under eval/ by the Media service; v1 and v2 scored on the same fields.
    The mock sees colours: t1 grey -> the default bedroom answer, t2 red -> a person and free text about her, t3 green ->
    invalid JSON on every attempt."""
    import base64
    import json
    import os
    import uuid
    import httpx
    from test_profile_search import make_user
    media = os.environ.get("FS_MEDIA_URL", "http://127.0.0.1:8095")
    tok = os.environ["INTERNAL_SERVICE_TOKEN"]
    photos = {"t1": plain((150, 140, 130)), "t2": plain((200, 40, 40)), "t3": plain((40, 200, 40))}
    for pid, data in photos.items():
        r = httpx.post(f"{media}/v1/eval/photos", headers={"X-Internal-Token": tok}, timeout=60,
                       json={"key": f"eval/p7/test-{pid}.jpg", "image_b64": base64.b64encode(data).decode(), "blur": True})
        assert r.status_code == 200, r.text
    ds = db.execute("""insert into eval.datasets (name, kind, version) values ('test_p7', 'vision', 1)
                       on conflict (name, version) do update set kind = excluded.kind returning id""").fetchone()[0]
    db.execute("delete from eval.queries where dataset_id = %s", (ds,))
    gold = {"room_type": "bedroom", "beds": 1, "bed_kinds": ["double"], "furniture": ["wardrobe"], "furniture_maybe": ["desk"],
            "appliances": ["tv"], "bathroom_fixtures": [], "windows": None, "natural_light": "good", "condition": "good",
            "condition_signs": [], "furnished": "*", "readable_text": False, "people_visible": False}
    for pid in photos:
        db.execute("insert into eval.queries (dataset_id, external_id, query, gold, tags) values (%s, %s, %s, %s::jsonb, %s)",
                   (ds, pid, f"eval/p7/test-{pid}.jpg", json.dumps({"labels": {**gold, "people_visible": pid == "t2"},
                                                                   "context": {"file": pid}}), ["bedroom"]))
    uid = make_user(db, "admin")
    r = client.call("POST", "/v1/admin/eval/prompt-runs", body={"prompt": "P7_photo_analyzer", "versions": [1, 2], "dataset": "test_p7"},
                    user_id=uid, idem="t-" + uuid.uuid4().hex)
    job = wait_job(client, uid, assert_ok(r, 202, "JobAcceptedResponse")["data"]["status_url"])
    assert job["status"] == "succeeded", job
    runs = {x["version"]: x for x in job["output"]["runs"]}
    for v in (1, 2):
        s = db.execute("select summary from eval.runs where id = %s", (runs[v]["run_id"],)).fetchone()[0]
        # per photo 6 determinable fields (windows is null, furnished is not scored): t1 and t2 right on all 6, t3 invalid
        assert s["items"] == 3 and s["json_valid"] == 0.6667 and s["determinable_fields"] == 18 and s["field_accuracy"] == 0.6667, s
        # windows not determinable: both answered photos give a number -> 2 unsupported answers
        assert s["not_determinable_fields"] == 2 and s["unsupported_answers"] == 2, s
        # each answer lists double, wardrobe, tv (hits), desk (a maybe: ignored), air_conditioning (hallucinated);
        # t3 misses its 3 gold objects -> precision 6/8, recall 6/9
        assert s["hallucinated_objects"] == 2 and s["object_precision"] == 0.75 and s["object_recall"] == 0.6667, s
        assert s["people_described_items"] == 1, s
    fails = {r[0] for r in db.execute("select category from ai.prompt_failures where eval_run_id = %s", (runs[2]["run_id"],))}
    assert {"format", "hallucinated_object", "unsupported_value", "describes_people"} <= fails, fails
