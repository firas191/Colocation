"""PLATFORM_SPEC 9 P12 and 8: the isolation matrix. Every operation in docs/openapi.yaml whose path names a resource
({id}, {chore_id}, ...) is called by a signed-in person who has nothing to do with that resource, with a valid body,
and must answer 403 or 404. A few paths are public on purpose or only touch the caller's own rows; they are listed in
NOT_CHECKED with the reason. A new path in the spec that is in neither list makes test_every_path_is_classified fail,
so a new endpoint cannot ship without its isolation case. Test jurisdiction TN (the document templates need it).
"""
import os
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path

import psycopg
import pytest
import yaml

from conftest import assert_ok
from test_profile_search import make_user

SPEC = yaml.safe_load((Path(__file__).resolve().parents[2] / "docs" / "openapi.yaml").read_text(encoding="utf-8"))
METHODS = ("get", "post", "put", "patch", "delete")

NOT_CHECKED = {
    ("GET", "/v1/listings/{id}/public"): "a published listing is public",
    ("GET", "/v1/listings/{id}/visit-slots"): "free slots of a published listing are public (who booked them is not; test_isolation.py)",
    ("GET", "/v1/flatmates/{user_id}"): "a flatmate profile the person made visible is public to signed-in people",
    ("DELETE", "/v1/me/blocks/{user_id}"): "acts on the caller's own blocks only",
    ("PUT", "/v1/me/favourites/{listing_id}"): "acts on the caller's own favourites; any published listing may be saved",
    ("DELETE", "/v1/me/favourites/{listing_id}"): "acts on the caller's own favourites only",
    ("POST", "/v1/flatmates/{user_id}/contact-requests"): "anyone signed in may ask a visible profile; the person asked decides (D-115)",
    ("POST", "/v1/flatmates/{user_id}/explanation"): "a visible profile, as GET /v1/flatmates/{user_id}; only factor states (D-115)",
}

# (method, path template, body). {h}, {lid} ... are filled from the world fixture.
CASES = [
    ("GET", "/v1/admin/eval/runs/{id}", "{uuid}", None),
    ("POST", "/v1/admin/moderation/{id}/decision", "{uuid}", {"action": "approve"}),
    ("PUT", "/v1/admin/settings/{key}", "reports.per_hour", {"value": 5}),
    ("GET", "/v1/admin/traces/{request_id}", "{uuid}", None),
    ("PUT", "/v1/admin/users/{id}/role", "{a}", {"role": "admin"}),
    ("POST", "/v1/applications/{id}/decision", "{app}", {"action": "accept"}),
    ("POST", "/v1/applications/{id}/withdraw", "{app}", {}),
    ("POST", "/v1/chore-assignments/{id}/done", "{turn}", {}),
    ("GET", "/v1/conversations/{id}/messages", "{conv}", None),
    ("POST", "/v1/conversations/{id}/messages", "{conv}", {"text": "intrus"}),
    ("POST", "/v1/conversations/{id}/read", "{conv}", {}),
    ("POST", "/v1/contact-requests/{id}/decision", "{creq}", {"action": "accept"}),
    ("GET", "/v1/documents/{id}", "{doc}", None),
    ("GET", "/v1/documents/{id}/comparison", "{doc}", None),
    ("GET", "/v1/households/{id}", "{h}", None),
    ("GET", "/v1/households/{id}/announcements", "{h}", None),
    ("POST", "/v1/households/{id}/announcements", "{h}", {"body": "intrus"}),
    ("GET", "/v1/households/{id}/balances", "{h}", None),
    ("GET", "/v1/households/{id}/calendar", "{h}", None),
    ("GET", "/v1/households/{id}/chores", "{h}", None),
    ("POST", "/v1/households/{id}/chores", "{h}", {"title": "x", "frequency": "weekly", "next_due_on": "2027-03-01"}),
    ("PATCH", "/v1/households/{id}/chores/{chore_id}", "{h}|{chore}", {"title": "x"}),
    ("GET", "/v1/households/{id}/deposits", "{h}", None),
    ("PUT", "/v1/households/{id}/deposits/{user_id}", "{h}|{a}", {"amount_minor": 1}),
    ("GET", "/v1/households/{id}/documents", "{h}", None),
    ("POST", "/v1/households/{id}/documents", "{h}", {"kind": "house_rules", "language": "fr", "values": {}}),
    ("POST", "/v1/households/{id}/documents/assistant", "{h}", {"text": "un contrat"}),
    ("POST", "/v1/households/{id}/events", "{h}", {"title": "x", "starts_at": "2027-03-05T19:00:00Z"}),
    ("DELETE", "/v1/households/{id}/events/{event_id}", "{h}|{event}", None),
    ("GET", "/v1/households/{id}/expenses", "{h}", None),
    ("POST", "/v1/households/{id}/expenses", "{h}", {"amount_minor": 1000, "label": "x", "category": "groceries"}),
    ("DELETE", "/v1/households/{id}/expenses/{expense_id}", "{h}|{expense}", None),
    ("POST", "/v1/households/{id}/invites", "{h}", {}),
    ("GET", "/v1/households/{id}/issues", "{h}", None),
    ("POST", "/v1/households/{id}/issues", "{h}", {"title": "x", "category": "plumbing", "urgency": "normal"}),
    ("POST", "/v1/households/{id}/leave", "{h}", {}),
    ("GET", "/v1/households/{id}/move-out", "{h}", None),
    ("POST", "/v1/households/{id}/move-out", "{h}", {"planned_on": "2027-06-30"}),
    ("PATCH", "/v1/households/{id}/move-out/{item}", "{h}|keys_returned", {"done": True}),
    ("GET", "/v1/households/{id}/recurring", "{h}", None),
    ("PUT", "/v1/households/{id}/recurring", "{h}", {"items": []}),
    ("GET", "/v1/households/{id}/rent-payments", "{h}", None),
    ("POST", "/v1/households/{id}/rent-payments", "{h}", {"period": "2027-02", "amount_minor": 1000}),
    ("POST", "/v1/households/{id}/room-posts", "{h}", {"title": "x"}),
    ("GET", "/v1/households/{id}/rules", "{h}", None),
    ("PUT", "/v1/households/{id}/rules", "{h}", {"items": []}),
    ("POST", "/v1/households/{id}/settlements", "{h}", {"to_user": "{a}", "amount_minor": 1000}),
    ("GET", "/v1/households/{id}/shopping", "{h}", None),
    ("POST", "/v1/households/{id}/shopping", "{h}", {"label": "x"}),
    ("PATCH", "/v1/households/{id}/shopping/{item_id}", "{h}|{item}", {"done": True}),
    ("POST", "/v1/issues/{id}/photos/presign", "{issue}", {"files": [{"content_type": "image/jpeg", "bytes": 1000}]}),
    ("POST", "/v1/issues/{id}/photos/process", "{issue}", {}),
    ("POST", "/v1/issues/{id}/updates", "{issue}", {"comment": "x"}),
    ("GET", "/v1/jobs/{id}", "{job}", None),
    ("POST", "/v1/listing-changes/{id}/cancel", "{change}", {}),
    ("GET", "/v1/listings/{id}", "{draft}", None),
    ("PATCH", "/v1/listings/{id}", "{draft}", {"title": "intrus"}),
    ("POST", "/v1/listings/{id}/analyze", "{draft}", {}),
    ("POST", "/v1/listings/{id}/applications", "{draft}", {"message": "Bonjour"}),
    ("POST", "/v1/listings/{id}/media/presign", "{draft}", {"files": [{"kind": "photo", "content_type": "image/jpeg", "bytes": 1000}]}),
    ("POST", "/v1/listings/{id}/submit", "{draft}", {}),
    ("PUT", "/v1/listings/{id}/visit-slots", "{lid}", {"slots": []}),
    ("POST", "/v2/listings/{id}/submit", "{draft}", {}),
    ("DELETE", "/v1/me/saved-searches/{id}", "{search}", None),
    ("POST", "/v1/rent-payments/{id}/confirm", "{payment}", {}),
    ("POST", "/v1/visits/{id}/decision", "{visit}", {"action": "confirm"}),
]


def idem():
    return "t-" + uuid.uuid4().hex


def spec_paths():
    return {(m.upper(), p) for p, ops in SPEC["paths"].items() if "{" in p for m in ops if m in METHODS}


def test_every_path_is_classified():
    cased = {(m, p) for m, p, _, _ in CASES}
    missing = spec_paths() - cased - set(NOT_CHECKED)
    assert not missing, f"paths with no isolation case (add them to CASES or NOT_CHECKED with a reason): {sorted(missing)}"
    stale = (cased | set(NOT_CHECKED)) - spec_paths()
    assert not stale, f"cases for paths that are not in the spec: {sorted(stale)}"


@pytest.fixture(scope="module")
def world(client):
    db = psycopg.connect(os.environ["FS_TEST_DB_DSN"], autocommit=True)
    a, b, s, x = (make_user(db, "user", ("terms", "privacy", "media_processing"), jurisdiction="TN") for _ in range(4))
    for u, n in ((a, "Amel"), (b, "Bilel"), (s, "Sami"), (x, "Xavier")):
        db.execute("update app.users set display_name = %s where id = %s", (n, u))
    c = lambda m, p, u, body=None: client.call(m, p, user_id=u, body=body, idem=idem() if m != "GET" else None)  # noqa: E731
    w = {"a": a, "x": x, "uuid": str(uuid.uuid4())}
    # Amel's published listing with a conversation, a visit and an application from Sami; a draft listing; a job
    w["lid"], w["draft"] = str(uuid.uuid4()), str(uuid.uuid4())
    for lid, st in ((w["lid"], "published"), (w["draft"], "draft")):
        db.execute("""insert into app.listings (id, owner_id, jurisdiction_code, status, title, description, published_at, is_synthetic, source)
                      values (%s, %s, 'TN', %s, 'Chambre matrice', 'x', case when %s = 'published' then now() end, true, 'synthetic')""",
                   (lid, a, st, st))
    w["conv"] = assert_ok(c("POST", "/v1/conversations", s, {"listing_id": w["lid"], "text": "Bonjour"}), 201)["data"]["conversation"]["conversation_id"]
    t0 = datetime.now(timezone.utc) + timedelta(days=4)
    fmt = lambda d: d.strftime("%Y-%m-%dT%H:%M:%SZ")  # noqa: E731
    slot = assert_ok(c("PUT", f"/v1/listings/{w['lid']}/visit-slots", a,
                       {"slots": [{"starts_at": fmt(t0), "ends_at": fmt(t0 + timedelta(hours=1)), "capacity": 3}]}), 200)["data"]["items"][0]["slot_id"]
    w["visit"] = assert_ok(c("POST", "/v1/visits", s, {"slot_id": slot}), 201)["data"]["visit_id"]
    w["app"] = assert_ok(c("POST", f"/v1/listings/{w['lid']}/applications", s, {"message": "Bonjour"}), 201)["data"]["application_id"]
    w["change"] = str(db.execute("""insert into ai.listing_changes (user_id, listing_id, changes, diff, status)
                                    values (%s, %s, '{"rent": 420}', '[{"field": "rent", "before": 400, "after": 420}]', 'pending')
                                    returning id""", (a, w["lid"])).fetchone()[0])
    w["job"] = str(db.execute("insert into app.jobs (type, status, input, requested_by) values ('listing_analyze', 'succeeded', '{}', %s) returning id",
                              (a,)).fetchone()[0])
    # a contact request between Amel and Bilel (D-115)
    assert_ok(c("PUT", "/v1/me/flatmate-profile", b, {"visible": True}), 200)
    w["creq"] = assert_ok(c("POST", f"/v1/flatmates/{b}/contact-requests", a, {}), 201)["data"]["request_id"]
    w["search"] = assert_ok(c("POST", "/v1/me/saved-searches", a, {"name": "Tunis", "query": {"jurisdiction": "TN", "kind": "room"}}),
                            201)["data"]["saved_search_id"]
    # Amel's household with Bilel, and one of everything in it
    h = w["h"] = assert_ok(c("POST", "/v1/households", a, {"name": "Dar Matrice", "jurisdiction_code": "TN",
                                                           "address_text": "1 rue de la Matrice, Tunis"}), 201)["data"]["household_id"]
    code = assert_ok(c("POST", f"/v1/households/{h}/invites", a, {}), 201)["data"]["code"]
    assert_ok(c("POST", "/v1/household-invites/accept", b, {"code": code}), 200)
    # weekly and due on a date of its own, so the turn made here does not add to the day-by-day counts of other files
    w["chore"] = assert_ok(c("POST", f"/v1/households/{h}/chores", a, {"title": "Vaisselle", "frequency": "weekly",
                                                                       "next_due_on": "2027-01-04"}), 201)["data"]["chore_id"]
    db.execute("select home.daily_chores('2027-01-04')")
    ch = assert_ok(c("GET", f"/v1/households/{h}/chores", a), 200)["data"]["items"][0]
    w["turn"] = ch["assignments"][0]["assignment_id"]
    w["event"] = assert_ok(c("POST", f"/v1/households/{h}/events", a, {"title": "Dîner", "starts_at": "2027-03-05T19:00:00Z"}), 201)["data"]["event_id"]
    w["expense"] = assert_ok(c("POST", f"/v1/households/{h}/expenses", a, {"amount_minor": 9000, "label": "Courses",
                                                                           "category": "groceries"}), 201)["data"]["expense_id"]
    w["item"] = assert_ok(c("POST", f"/v1/households/{h}/shopping", a, {"label": "Pain"}), 201)["data"]["item_id"]
    w["issue"] = assert_ok(c("POST", f"/v1/households/{h}/issues", a, {"title": "Fuite", "category": "plumbing", "urgency": "normal"}),
                           201)["data"]["issue_id"]
    w["payment"] = assert_ok(c("POST", f"/v1/households/{h}/rent-payments", b, {"period": "2027-01", "amount_minor": 40000}), 201)["data"]["payment_id"]
    w["doc"] = assert_ok(c("POST", f"/v1/households/{h}/documents", a, {"kind": "inventory_entry", "language": "fr",
                         "values": {"date": "2026-11-01", "items": [{"room": "Chambre", "item": "Lit", "condition": "bon"}]}}), 201)["data"]["document_id"]
    assert_ok(c("POST", f"/v1/households/{h}/move-out", a, {"planned_on": "2027-06-30"}), 201)
    w["c"], w["db"] = c, db
    yield w
    db.execute("delete from app.rate_counters where bucket like 'ip:%'")
    db.close()


def _fill(v, w):
    if isinstance(v, str):
        return v.format(**{k: w[k] for k in w if isinstance(w[k], str)})
    if isinstance(v, dict):
        return {k: _fill(x, w) for k, x in v.items()}
    if isinstance(v, list):
        return [_fill(x, w) for x in v]
    return v


@pytest.mark.parametrize("method,path,ids,body", CASES, ids=[f"{m} {p}" for m, p, _, _ in CASES])
def test_outsider_is_refused(client, world, method, path, ids, body):
    vals = _fill(ids, world).split("|")
    concrete = path
    for part in [seg for seg in path.split("/") if seg.startswith("{")]:
        concrete = concrete.replace(part, vals.pop(0), 1)
    # one person makes all these calls within seconds; the per-person and per-address limits are not under test here
    world["db"].execute("delete from app.rate_counters where bucket like %s or bucket like 'ip:%%'", (f"%{world['x']}%",))
    r = world["c"](method, concrete, world["x"], _fill(body, world))
    assert r.status_code in (403, 404), f"{method} {concrete} by an outsider answered {r.status_code}: {r.text[:300]}"
    assert r.json()["error"]["code"] in ("FORBIDDEN", "NOT_FOUND")


def test_nothing_changed(client, world):
    c, a, h, db = world["c"], world["a"], world["h"], world["db"]
    hh = assert_ok(c("GET", f"/v1/households/{h}", a), 200)["data"]
    assert len(hh["members"]) == 2, "the outsider did not join or leave anything"
    assert [e["label"] for e in assert_ok(c("GET", f"/v1/households/{h}/expenses", a), 200)["data"]["items"]] == ["Courses"]
    assert [i["label"] for i in assert_ok(c("GET", f"/v1/households/{h}/shopping", a), 200)["data"]["items"]] == ["Pain"]
    assert db.execute("select title from app.listings where id = %s", (world["draft"],)).fetchone()[0] == "Chambre matrice"
    assert db.execute("select status from ai.listing_changes where id = %s", (world["change"],)).fetchone()[0] == "pending"
    assert db.execute("select role from app.users where id = %s", (a,)).fetchone()[0] == "user"
