"""PLATFORM_SPEC 8: every conversation, visit and application operation run by a user who is not part of it. Each one
answers 404 (someone else's resource, rule 2.5) or leaves it out of the lists, and changes nothing. Households join
this file in P5. Test jurisdiction QU."""
import os
import uuid
from datetime import datetime, timedelta, timezone

import psycopg
import pytest

from conftest import assert_error, assert_ok
from test_profile_search import make_user

LISTING = "00000000-0000-4000-8000-0000000005a1"


def idem():
    return "t-" + uuid.uuid4().hex


@pytest.fixture(scope="module")
def world(client):
    db = psycopg.connect(os.environ["FS_TEST_DB_DSN"], autocommit=True)
    db.execute("""insert into app.jurisdictions (code, country_code, name, default_currency, default_locale, languages, timezone)
                  values ('QU', 'QU', 'Test jurisdiction isolation (tests only)', 'TND', 'fr-TN', '{fr}', 'Africa/Tunis')
                  on conflict (code) do nothing""")
    db.execute("delete from app.listings where jurisdiction_code = 'QU'")
    s, o, x = (make_user(db, "user", ("terms", "privacy"), jurisdiction="QU") for _ in range(3))
    db.execute("""insert into app.listings (id, owner_id, jurisdiction_code, status, title, description, published_at, is_synthetic, source)
                  values (%s, %s, 'QU', 'published', 'Chambre QU', 'x', now(), true, 'synthetic')""", (LISTING, o))
    c = lambda m, p, u, b=None: client.call(m, p, user_id=u, body=b, idem=idem() if m != "GET" else None)  # noqa: E731
    conv = assert_ok(c("POST", "/v1/conversations", s, {"listing_id": LISTING, "text": "Bonjour"}), 201)["data"]["conversation"]["conversation_id"]
    t0 = datetime.now(timezone.utc) + timedelta(days=4)
    fmt = lambda d: d.strftime("%Y-%m-%dT%H:%M:%SZ")  # noqa: E731
    slot = assert_ok(c("PUT", f"/v1/listings/{LISTING}/visit-slots", o,
                       {"slots": [{"starts_at": fmt(t0), "ends_at": fmt(t0 + timedelta(hours=1)), "capacity": 3}]}), 200)["data"]["items"][0]["slot_id"]
    visit = assert_ok(c("POST", "/v1/visits", s, {"slot_id": slot}), 201)["data"]["visit_id"]
    app = assert_ok(c("POST", f"/v1/listings/{LISTING}/applications", s, {"message": "Bonjour"}), 201)["data"]["application_id"]
    msg = assert_ok(c("GET", f"/v1/conversations/{conv}/messages", s), 200)["data"]["items"][0]["id"]
    yield {"db": db, "seeker": s, "owner": o, "outsider": x, "conv": conv, "visit": visit, "app": app, "msg": msg, "c": c}
    db.execute("delete from app.rate_counters where bucket like 'ip:%'")
    db.close()


@pytest.mark.parametrize("method,path,body", [
    ("GET", "/v1/conversations/{conv}/messages", None),
    ("POST", "/v1/conversations/{conv}/messages", {"text": "intrus"}),
    ("POST", "/v1/conversations/{conv}/read", {}),
    ("POST", "/v1/visits/{visit}/decision", {"action": "cancel"}),
    ("POST", "/v1/visits/{visit}/decision", {"action": "confirm"}),
    ("POST", "/v1/applications/{app}/decision", {"action": "accept"}),
    ("POST", "/v1/applications/{app}/withdraw", {}),
    ("PUT", "/v1/listings/" + LISTING + "/visit-slots", {"slots": []}),
    ("POST", "/v1/me/blocks", {"user_id": "{seeker}"}),
    ("POST", "/v1/reports", {"target_type": "message", "target_id": "{msg}", "reason": "spam"}),
    ("POST", "/v1/reports", {"target_type": "user", "target_id": "{seeker}", "reason": "spam"}),
])
def test_outsider_gets_404(client, world, method, path, body):
    fill = lambda v: v.format(**{k: world[k] for k in ("conv", "visit", "app", "seeker", "msg")}) if isinstance(v, str) else v  # noqa: E731
    b = {k: fill(v) for k, v in body.items()} if body else body
    assert_error(world["c"](method, fill(path), world["outsider"], b), 404, "NOT_FOUND")


def test_outsider_lists_are_empty_and_nothing_changed(client, world):
    c, x = world["c"], world["outsider"]
    assert assert_ok(c("GET", "/v1/conversations", x), 200)["data"]["items"] == []
    assert assert_ok(c("GET", "/v1/me/visits", x), 200)["data"]["items"] == []
    assert assert_ok(c("GET", "/v1/me/applications", x), 200)["data"]["items"] == []
    assert assert_ok(c("GET", "/v1/owner/applications", x), 200)["data"]["items"] == []
    s = world["seeker"]
    msgs = assert_ok(c("GET", f"/v1/conversations/{world['conv']}/messages", s), 200)["data"]["items"]
    assert [m["body"] for m in msgs] == ["Bonjour"], "the outsider's message was not written"
    assert assert_ok(c("GET", "/v1/me/visits", s), 200)["data"]["items"][0]["status"] == "requested"
    assert assert_ok(c("GET", "/v1/me/applications", s), 200)["data"]["items"][0]["status"] == "submitted"
    assert assert_ok(c("GET", f"/v1/listings/{LISTING}/visit-slots", s), 200)["data"]["items"][0]["capacity"] == 3
    # the outsider sees the published listing's slots (they are public), not who booked them
    seen = assert_ok(c("GET", f"/v1/listings/{LISTING}/visit-slots", x), 200)["data"]["items"][0]
    assert set(seen) == {"slot_id", "starts_at", "ends_at", "capacity", "free"} and seen["free"] == 2
