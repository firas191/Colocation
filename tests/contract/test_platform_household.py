"""Platform P5 (docs/PLATFORM_SPEC.md 3.6, 9 P5; D-104): households, invites, expenses with the three split modes,
balances and suggested settlements, settlements, recurring rent and bills with the daily reminder, rent payments
confirmed by the owner member, announcements; an accepted application becomes a household invite.

The demo script of P5: two flatmates and an owner, three expenses with different splits, balances shown, one
settlement recorded, a rent reminder on the right day (home.daily_reminders with a fixed today, D-104).
Test jurisdiction QT.
"""
import os
import uuid

import psycopg
import pytest

from conftest import assert_error, assert_ok
from test_profile_search import make_user


def idem():
    return "t-" + uuid.uuid4().hex


@pytest.fixture(scope="module")
def p5(client):
    db = psycopg.connect(os.environ["FS_TEST_DB_DSN"], autocommit=True)
    db.execute("""insert into app.jurisdictions (code, country_code, name, default_currency, default_locale, languages, timezone)
                  values ('QT', 'QT', 'Test jurisdiction P5 (tests only)', 'TND', 'fr-TN', '{fr}', 'Africa/Tunis') on conflict (code) do nothing""")
    u = {k: make_user(db, "user", ("terms", "privacy"), jurisdiction="QT") for k in ("amel", "bilel", "owner", "outsider", "applicant")}
    for k, n in (("amel", "Amel"), ("bilel", "Bilel"), ("owner", "Omar")):
        db.execute("update app.users set display_name = %s where id = %s", (n, u[k]))
    yield {"db": db, **u, "s": {}}
    db.execute("delete from app.rate_counters where bucket like 'ip:%'")
    db.close()


def c(client, method, path, uid, body=None, params=None):
    return client.call(method, path, user_id=uid, body=body, params=params, idem=idem() if method != "GET" else None)


def test_needs_user_consent_and_validation(client, p5):
    assert_error(client.call("GET", "/v1/me/households"), 401, "UNAUTHENTICATED")
    nc = make_user(p5["db"], "user", (), jurisdiction="QT")
    assert_error(client.call("GET", "/v1/me/households", user_id=nc), 403, "CONSENT_REQUIRED")
    j = assert_error(c(client, "POST", "/v1/households", p5["amel"], {"name": "", "jurisdiction_code": "QT", "x": 1}), 422, "VALIDATION_FAILED")
    assert {d["field"] for d in j["error"]["details"]} == {"name", "x"}
    j = assert_error(c(client, "POST", "/v1/households", p5["amel"], {"name": "Maison", "jurisdiction_code": "ZZ"}), 422, "VALIDATION_FAILED")
    assert j["error"]["details"] == [{"field": "jurisdiction_code", "issue": "unknown_jurisdiction"}]
    j = assert_error(c(client, "POST", "/v1/household-invites/accept", p5["amel"], {}), 422, "VALIDATION_FAILED")
    assert j["error"]["details"] == [{"field": "code|invite_id", "issue": "one_required"}]


def test_create_and_invite(client, p5):
    a, b, o, s = p5["amel"], p5["bilel"], p5["owner"], p5["s"]
    key = idem()
    r = client.call("POST", "/v1/households", user_id=a, body={"name": "Rue de Marseille", "jurisdiction_code": "qt"}, idem=key)
    h = assert_ok(r, 201, "HouseholdResponse")["data"]
    s["h"] = h["household_id"]
    assert h["my_role"] == "flatmate" and h["currency"] == "TND" and h["exponent"] == 3
    again = client.call("POST", "/v1/households", user_id=a, body={"name": "Rue de Marseille", "jurisdiction_code": "qt"}, idem=key)
    assert again.json() == r.json(), "same key: the stored answer, one household"
    code = assert_ok(c(client, "POST", f"/v1/households/{s['h']}/invites", a, {}), 201, "HouseholdInviteResponse")["data"]["code"]
    joined = assert_ok(c(client, "POST", "/v1/household-invites/accept", b, {"code": code.lower()}), 200, "HouseholdResponse")["data"]
    assert joined["my_role"] == "flatmate" and len(joined["members"]) == 2
    j = assert_error(c(client, "POST", "/v1/household-invites/accept", p5["outsider"], {"code": code}), 409, "CONFLICT")
    assert j["error"]["details"] == [{"field": "code", "issue": "used"}]
    assert_error(c(client, "POST", "/v1/household-invites/accept", p5["outsider"], {"code": "AAAA-BBBB-CCCC"}), 404, "NOT_FOUND")
    ocode = assert_ok(c(client, "POST", f"/v1/households/{s['h']}/invites", a, {"role": "owner"}), 201)["data"]["code"]
    assert assert_ok(c(client, "POST", "/v1/household-invites/accept", o, {"code": ocode}), 200)["data"]["my_role"] == "owner"
    mine = assert_ok(c(client, "GET", "/v1/me/households", b), 200, "HouseholdsResponse")["data"]
    assert [x["household_id"] for x in mine["items"]] == [s["h"]]
    assert_error(c(client, "GET", f"/v1/households/{s['h']}", p5["outsider"]), 404, "NOT_FOUND")


def test_three_expenses_balances_and_a_settlement(client, p5):
    a, b, o, h = p5["amel"], p5["bilel"], p5["owner"], p5["s"]["h"]
    base = f"/v1/households/{h}/expenses"
    pv = assert_ok(c(client, "POST", base, a, {"amount_minor": 90001, "label": "Courses", "category": "groceries", "preview": True}), 200, "ExpenseResponse")["data"]
    assert pv["preview"] is True and sorted(x["share_minor"] for x in pv["shares"]) == [45000, 45001]
    assert assert_ok(c(client, "GET", base, a), 200, "ExpensesResponse")["data"]["items"] == [], "a preview saves nothing"
    # equal: 90.001 TND paid by Amel, 45.001 (Amel, first in join order) and 45.000
    assert_ok(c(client, "POST", base, a, {"amount_minor": 90001, "label": "Courses", "category": "groceries"}), 201, "ExpenseResponse")
    # shares 2:1: 30.000 paid by Bilel, Amel 20.000, Bilel 10.000
    assert_ok(c(client, "POST", base, b, {"amount_minor": 30000, "label": "Internet", "category": "internet", "split_mode": "shares",
                                          "participants": [a, b], "values": [2, 1]}), 201)
    # exact: 12.000 paid by Amel, Amel 5.000, Bilel 7.000
    assert_ok(c(client, "POST", base, a, {"amount_minor": 12000, "label": "Gaz", "category": "utilities", "split_mode": "exact",
                                          "participants": [b, a], "values": [7000, 5000]}), 201)
    j = assert_error(c(client, "POST", base, a, {"amount_minor": 12000, "label": "x", "split_mode": "exact", "values": [1, 2]}), 422, "VALIDATION_FAILED")
    assert j["error"]["details"][0]["issue"] == "sum_differs"
    j = assert_error(c(client, "POST", base, a, {"amount_minor": 1000, "label": "x", "participants": [o]}), 422, "VALIDATION_FAILED")
    assert j["error"]["details"] == [{"field": "participants", "issue": "not_a_flatmate"}]
    # Amel: +90001 + 12000 - 45001 - 20000 - 5000 = 32000; Bilel: +30000 - 45000 - 10000 - 7000 = -32000 (written by hand)
    bal = assert_ok(c(client, "GET", f"/v1/households/{h}/balances", b), 200, "BalancesResponse")["data"]
    assert {x["user_id"]: x["balance_minor"] for x in bal["balances"]} == {a: 32000, b: -32000}
    assert [(x["from"]["user_id"], x["to"]["user_id"], x["amount_minor"]) for x in bal["suggested"]] == [(b, a, 32000)]
    assert_ok(c(client, "POST", f"/v1/households/{h}/settlements", b, {"to_user": a, "amount_minor": 32000}), 201, "SettlementResponse")
    bal = assert_ok(c(client, "GET", f"/v1/households/{h}/balances", a), 200)["data"]
    assert all(x["balance_minor"] == 0 for x in bal["balances"]) and bal["suggested"] == []
    # the owner member does not see the money (PLATFORM_SPEC 7.3)
    assert_error(c(client, "GET", f"/v1/households/{h}/balances", o), 403, "FORBIDDEN")
    assert_error(c(client, "GET", base, o), 403, "FORBIDDEN")
    # deleting: only who added it
    eid = assert_ok(c(client, "GET", base, a), 200)["data"]["items"][0]["expense_id"]
    assert_error(c(client, "DELETE", f"{base}/{eid}", b), 403, "FORBIDDEN")
    assert assert_ok(c(client, "DELETE", f"{base}/{eid}", a), 200, "ExpenseResponse")["data"]["deleted"] is True


def test_rent_reminder_on_the_right_day_and_payments(client, p5):
    a, b, o, h, db = p5["amel"], p5["bilel"], p5["owner"], p5["s"]["h"], p5["db"]
    r = assert_ok(c(client, "PUT", f"/v1/households/{h}/recurring", a, {"items": [
        {"kind": "rent", "label": "Loyer", "amount_minor": 800000, "due_day": 5, "remind_days_before": 3},
        {"kind": "bill", "label": "STEG", "due_day": 20, "remind_days_before": 2}]}), 200, "RecurringResponse")["data"]
    assert [x["label"] for x in r["items"]] == ["Loyer", "STEG"]
    assert db.execute("select home.daily_reminders('2027-01-01')").fetchone()[0]["reminders"] == 0
    assert db.execute("select home.daily_reminders('2027-01-02')").fetchone()[0]["reminders"] == 1
    assert db.execute("select home.daily_reminders('2027-01-02')").fetchone()[0]["reminders"] == 0, "once per due date"
    for who, expected in ((a, 1), (b, 1), (o, 0)):
        n = assert_ok(c(client, "GET", "/v1/me/notifications", who), 200)["data"]["items"]
        assert len([x for x in n if x["type"] == "rent_due" and x["params"]["due_on"] == "2027-01-05"]) == expected
    p = assert_ok(c(client, "POST", f"/v1/households/{h}/rent-payments", b, {"period": "2027-01", "amount_minor": 400000}), 201, "RentPaymentResponse")["data"]
    assert p["confirmed"] is False
    assert_error(c(client, "POST", f"/v1/rent-payments/{p['payment_id']}/confirm", a, {}), 403, "FORBIDDEN")
    assert_error(c(client, "POST", f"/v1/rent-payments/{p['payment_id']}/confirm", p5["outsider"], {}), 404, "NOT_FOUND")
    done = assert_ok(c(client, "POST", f"/v1/rent-payments/{p['payment_id']}/confirm", o, {}), 200, "RentPaymentResponse")["data"]
    assert done["confirmed"] is True
    lst = assert_ok(c(client, "GET", f"/v1/households/{h}/rent-payments", o), 200, "RentPaymentsResponse")["data"]["items"]
    assert [x["payment_id"] for x in lst] == [p["payment_id"]]


def test_announcements(client, p5):
    a, o, h = p5["amel"], p5["owner"], p5["s"]["h"]
    assert_ok(c(client, "POST", f"/v1/households/{h}/announcements", o, {"body": "Le plombier passe jeudi.", "pinned": True}), 201,
              "AnnouncementCreatedResponse")
    items = assert_ok(c(client, "GET", f"/v1/households/{h}/announcements", a), 200, "AnnouncementsResponse")["data"]["items"]
    assert items[0]["body"] == "Le plombier passe jeudi." and items[0]["pinned"] is True
    assert_error(c(client, "GET", f"/v1/households/{h}/announcements", p5["outsider"]), 404, "NOT_FOUND")


def test_accepted_application_invites_to_the_household(client, p5):
    db, o, ap = p5["db"], p5["owner"], p5["applicant"]
    lid = str(uuid.uuid4())
    db.execute("""insert into app.listings (id, owner_id, jurisdiction_code, status, title, description, published_at, is_synthetic, source)
                  values (%s, %s, 'QT', 'published', 'Chambre QT', 'x', now(), true, 'synthetic')""", (lid, o))
    h2 = assert_ok(c(client, "POST", "/v1/households", o, {"name": "Coloc d'Omar", "jurisdiction_code": "QT", "listing_id": lid, "role": "owner"}), 201)["data"]["household_id"]
    app = assert_ok(c(client, "POST", f"/v1/listings/{lid}/applications", ap, {"message": "Bonjour"}), 201)["data"]["application_id"]
    d = assert_ok(c(client, "POST", f"/v1/applications/{app}/decision", o, {"action": "accept"}), 200)["data"]
    assert d["household_invite"] is True
    inv = assert_ok(c(client, "GET", "/v1/me/households", ap), 200)["data"]["invites"]
    assert inv[0]["household"] == {"household_id": h2, "name": "Coloc d'Omar"}
    joined = assert_ok(c(client, "POST", "/v1/household-invites/accept", ap, {"invite_id": inv[0]["invite_id"]}), 200)["data"]
    assert joined["household_id"] == h2 and joined["my_role"] == "flatmate"
    assert_error(c(client, "POST", "/v1/household-invites/accept", p5["outsider"], {"invite_id": inv[0]["invite_id"]}), 404, "NOT_FOUND")


def test_member_who_left_sees_nothing(client, p5):
    a, b, h = p5["amel"], p5["bilel"], p5["s"]["h"]
    # Bilel's balance is not zero: from P10 he says he knows (acknowledge_balance), else 409 balance_not_settled (D-109)
    assert assert_ok(c(client, "POST", f"/v1/households/{h}/leave", b, {"acknowledge_balance": True}), 200, "HouseholdLeftResponse")["data"]["status"] == "left"
    for path in (f"/v1/households/{h}", f"/v1/households/{h}/expenses", f"/v1/households/{h}/balances", f"/v1/households/{h}/announcements"):
        assert_error(c(client, "GET", path, b), 404, "NOT_FOUND")
    assert assert_ok(c(client, "GET", "/v1/me/households", b), 200)["data"]["items"] == []
    bal = assert_ok(c(client, "GET", f"/v1/households/{h}/balances", a), 200)["data"]["balances"]
    assert b in [x["user_id"] for x in bal], "the expenses Bilel shared stay in the balances"
