"""Platform P6 (docs/PLATFORM_SPEC.md 3.6, 9 P6; D-105): chores rota, shopping list, house rules, calendar, repairs and
issues with photos. A week of the demo household: a daily chore over three flatmates (one leaves), the shopping
list, rules, an event, an issue with a photo that goes through the Media service (EXIF removed, faces blurred).
Test jurisdiction QS.
"""
import os
import uuid

import httpx
import psycopg
import pytest

from conftest import assert_error, assert_ok
from test_intake_media import photo, put_upload
from test_platform_search import fetch
from test_profile_search import make_user


def idem():
    return "t-" + uuid.uuid4().hex


def c(client, method, path, uid, body=None, params=None):
    return client.call(method, path, user_id=uid, body=body, params=params, idem=idem() if method != "GET" else None)


@pytest.fixture(scope="module")
def p6(client):
    db = psycopg.connect(os.environ["FS_TEST_DB_DSN"], autocommit=True)
    db.execute("""insert into app.jurisdictions (code, country_code, name, default_currency, default_locale, languages, timezone)
                  values ('QS', 'QS', 'Test jurisdiction P6 (tests only)', 'TND', 'fr-TN', '{fr}', 'UTC') on conflict (code) do nothing""")
    u = {k: make_user(db, "user", ("terms", "privacy"), jurisdiction="QS") for k in ("a", "b", "c", "owner", "outsider")}
    h = assert_ok(c(client, "POST", "/v1/households", u["a"], {"name": "Semaine type", "jurisdiction_code": "QS"}), 201)["data"]["household_id"]
    for k, role in (("b", "flatmate"), ("c", "flatmate"), ("owner", "owner")):
        code = assert_ok(c(client, "POST", f"/v1/households/{h}/invites", u["a"], {"role": role}), 201)["data"]["code"]
        assert_ok(c(client, "POST", "/v1/household-invites/accept", u[k], {"code": code}), 200)
    yield {"db": db, "h": h, **u}
    db.execute("delete from app.rate_counters where bucket like 'ip:%'")
    db.close()


def test_chore_rotation_over_a_week(client, p6):
    a, b, h, db = p6["a"], p6["b"], p6["h"], p6["db"]
    ch = assert_ok(c(client, "POST", f"/v1/households/{h}/chores", a, {"title": "Vaisselle", "frequency": "daily", "next_due_on": "2027-03-01"}),
                   201, "ChoreResponse")["data"]
    assert [x["user_id"] for x in ch["rotation"]] == [a, b, p6["c"]] and ch["next_person"]["user_id"] == a
    # home.daily_chores runs for every household in the database: count this household's turns, not its total (T-77:
    # chores that other test files left behind made the total 6 on the PC)
    turns = lambda: assert_ok(c(client, "GET", f"/v1/households/{h}/chores", a), 200)["data"]["items"][0]["assignments"]  # noqa: E731
    db.execute("select home.daily_chores('2027-03-04')")
    assert len(turns()) == 4
    assert_ok(c(client, "POST", f"/v1/households/{h}/leave", b, {}), 200)
    db.execute("select home.daily_chores('2027-03-07')")
    assert len(turns()) == 7
    lst = assert_ok(c(client, "GET", f"/v1/households/{h}/chores", a), 200, "ChoresResponse")["data"]["items"][0]
    order = [x["user"]["user_id"] for x in sorted(lst["assignments"], key=lambda x: x["due_on"])]
    assert order == [a, b, p6["c"], a, p6["c"], a, p6["c"]], "a full week; after Bilel left he is skipped"
    turn = next(x for x in lst["assignments"] if x["due_on"] == "2027-03-07")
    done = assert_ok(c(client, "POST", f"/v1/chore-assignments/{turn['assignment_id']}/done", a, {}), 200, "ChoreResponse")["data"]
    assert next(x for x in done["assignments"] if x["assignment_id"] == turn["assignment_id"])["done"] is True
    assert_error(c(client, "GET", f"/v1/households/{h}/chores", p6["owner"]), 403, "FORBIDDEN")
    assert_error(c(client, "POST", f"/v1/chore-assignments/{turn['assignment_id']}/done", p6["outsider"], {}), 404, "NOT_FOUND")


def test_shopping_rules_calendar(client, p6):
    a, o, h = p6["a"], p6["owner"], p6["h"]
    it = assert_ok(c(client, "POST", f"/v1/households/{h}/shopping", a, {"label": "Pain", "quantity": "2"}), 201, "ShoppingItemResponse")["data"]
    assert assert_ok(c(client, "PATCH", f"/v1/households/{h}/shopping/{it['item_id']}", p6["c"], {"done": True}), 200)["data"]["done"] is True
    assert_error(c(client, "GET", f"/v1/households/{h}/shopping", o), 403, "FORBIDDEN")
    r = assert_ok(c(client, "PUT", f"/v1/households/{h}/rules", o, {"items": [{"category": "quiet", "text": "Calme après 22 h"},
                                                                            {"category": "guests", "text": "Prévenir la veille"}]}), 200, "RulesResponse")
    assert [x["text"] for x in r["data"]["items"]] == ["Calme après 22 h", "Prévenir la veille"]
    ev = assert_ok(c(client, "POST", f"/v1/households/{h}/events", a, {"title": "Dîner", "starts_at": "2027-03-05T19:00:00Z"}), 201, "EventResponse")["data"]
    cal = assert_ok(c(client, "GET", f"/v1/households/{h}/calendar", a, params={"from": "2027-03-01", "to": "2027-03-10"}), 200, "CalendarResponse")["data"]
    assert {x["kind"] for x in cal["items"]} >= {"event", "chore"}
    cal = assert_ok(c(client, "GET", f"/v1/households/{h}/calendar", o, params={"from": "2027-03-01", "to": "2027-03-10"}), 200)["data"]
    assert {x["kind"] for x in cal["items"]} == {"event"}, "the owner member's calendar has no chore turns (7.3)"
    assert_error(c(client, "DELETE", f"/v1/households/{h}/events/{ev['event_id']}", o), 403, "FORBIDDEN")
    assert_ok(c(client, "DELETE", f"/v1/households/{h}/events/{ev['event_id']}", a), 200)
    assert_error(c(client, "GET", f"/v1/households/{h}/calendar", a, params={"from": "2027-01-01", "to": "2027-12-31"}), 422, "VALIDATION_FAILED")
    assert_error(c(client, "GET", f"/v1/households/{h}/rules", p6["outsider"]), 404, "NOT_FOUND")


def test_issue_with_a_photo_to_the_owner(client, p6):
    cc, o, h = p6["c"], p6["owner"], p6["h"]
    i = assert_ok(c(client, "POST", f"/v1/households/{h}/issues", cc, {"title": "Fuite sous l'évier", "category": "plumbing", "urgency": "urgent"}),
                  201, "IssueResponse")["data"]
    n = assert_ok(c(client, "GET", "/v1/me/notifications", o), 200)["data"]["items"]
    assert any(x["type"] == "issue_reported_owner" for x in n), "the owner member is told"
    up = assert_ok(c(client, "POST", f"/v1/issues/{i['issue_id']}/photos/presign", cc,
                     {"files": [{"content_type": "image/jpeg", "bytes": 300000}]}), 200, "IssueUploadsResponse")["data"]["uploads"]
    assert put_upload(up[0], photo(77, gps=True)).status_code == 200
    pr = assert_ok(c(client, "POST", f"/v1/issues/{i['issue_id']}/photos/process", cc, {}), 200, "IssuePhotosProcessedResponse")["data"]
    assert pr["processed"] == 1 and pr["rejected"] == [] and pr["pending"] == 0
    lst = assert_ok(c(client, "GET", f"/v1/households/{h}/issues", o), 200, "IssuesResponse")["data"]
    ph = lst["items"][0]["photos"]
    assert len(ph) == 1 and "/media/issues/" in ph[0]["url"]
    img = fetch(ph[0]["url"])
    assert img.status_code == 200 and img.content[:2] == b"\xff\xd8"
    assert b"Exif\x00\x00" not in img.content, "the EXIF block (with the GPS position of the original) is removed"
    assert_ok(c(client, "POST", f"/v1/issues/{i['issue_id']}/updates", o, {"status": "in_progress", "comment": "Plombier mardi"}), 200, "IssueResponse")
    assert_error(c(client, "POST", f"/v1/issues/{i['issue_id']}/updates", cc, {"status": "resolved"}), 403, "FORBIDDEN")
    assert_error(c(client, "POST", f"/v1/issues/{i['issue_id']}/updates", p6["outsider"], {"comment": "x"}), 404, "NOT_FOUND")
    assert_error(c(client, "POST", f"/v1/issues/{i['issue_id']}/photos/presign", p6["outsider"],
                   {"files": [{"content_type": "image/jpeg", "bytes": 1}]}), 404, "NOT_FOUND")
    # the owner member sees the issues but not the expenses (7.3)
    assert_error(c(client, "GET", f"/v1/households/{h}/expenses", o), 403, "FORBIDDEN")
