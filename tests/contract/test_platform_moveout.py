"""Platform P10 (docs/PLATFORM_SPEC.md 3.9, 7.4, 9 P10; D-109): leaving with a balance, deposits, the move-out
checklist, the exit inventory compared with the entry one, and deleting one's account. A TN household (the inventory
templates are TN's) with two flatmates and the owner member.
"""
import os
import uuid

import psycopg
import pytest

from conftest import assert_error, assert_ok
from test_profile_search import make_user


def idem():
    return "t-" + uuid.uuid4().hex


def c(client, method, path, uid, body=None, params=None):
    return client.call(method, path, user_id=uid, body=body, params=params, idem=idem() if method != "GET" else None)


@pytest.fixture(scope="module")
def p10(client):
    db = psycopg.connect(os.environ["FS_TEST_DB_DSN"], autocommit=True)
    u = {k: make_user(db, "user", ("terms", "privacy"), jurisdiction="TN") for k in ("a", "b", "owner", "gone")}
    for k, name in (("a", "Amel"), ("b", "Bilel"), ("owner", "Omar"), ("gone", "Ghada")):
        db.execute("update app.users set display_name = %s where id = %s", (name, u[k]))
    h = assert_ok(c(client, "POST", "/v1/households", u["a"], {"name": "Dar Zitouna", "jurisdiction_code": "TN",
                                                               "address_text": "4 rue du Jasmin, Tunis"}), 201)["data"]["household_id"]
    for k, role in (("b", "flatmate"), ("owner", "owner"), ("gone", "flatmate")):
        code = assert_ok(c(client, "POST", f"/v1/households/{h}/invites", u["a"], {"role": role}), 201)["data"]["code"]
        assert_ok(c(client, "POST", "/v1/household-invites/accept", u[k], {"code": code}), 200)
    yield {"db": db, "h": h, **u}
    db.execute("delete from app.rate_counters where bucket like 'ip:%'")
    db.close()


def test_leaving_with_a_balance(client, p10):
    a, b, h = p10["a"], p10["b"], p10["h"]
    assert_ok(c(client, "POST", f"/v1/households/{h}/expenses", a, {"amount_minor": 90000, "label": "Courses", "category": "groceries",
                                                                     "participants": [a, b]}), 201)
    r = assert_error(c(client, "POST", f"/v1/households/{h}/leave", b, {}), 409, "CONFLICT")
    assert r["error"]["details"][0] == {"field": "balance", "issue": "balance_not_settled", "balance_minor": -45000}
    assert assert_ok(c(client, "POST", f"/v1/households/{h}/leave", b, {"acknowledge_balance": True}), 200)["data"]["balance_minor"] == -45000


def test_deposit_and_move_out_checklist(client, p10):
    a, o, h = p10["a"], p10["owner"], p10["h"]
    path = f"/v1/households/{h}/deposits/{a}"
    assert_error(c(client, "PUT", path, a, {"amount_minor": 500000}), 403, "FORBIDDEN")
    bad = assert_error(c(client, "PUT", path, o, {"amount_minor": 500000, "returned_minor": 450000, "returned_on": "2027-07-01",
                                                  "deductions": [{"reason": "Vitre", "amount_minor": 10000}]}), 422, "VALIDATION_FAILED")
    assert bad["error"]["details"][0]["issue"] == "sum_mismatch"
    d = assert_ok(c(client, "PUT", path, o, {"amount_minor": 500000, "paid_on": "2026-09-01", "returned_minor": 450000, "returned_on": "2027-07-01",
                                             "deductions": [{"reason": "Vitre", "amount_minor": 50000}]}), 200, "DepositResponse")["data"]
    assert d["kept_minor"] == 50000
    assert len(assert_ok(c(client, "GET", f"/v1/households/{h}/deposits", a), 200, "DepositsResponse")["data"]["items"]) == 1
    m = assert_ok(c(client, "POST", f"/v1/households/{h}/move-out", a, {"planned_on": "2027-06-30"}), 201, "MoveOutResponse")["data"]["move_out"]
    st = {x["key"]: x["done"] for x in m["items"]}
    assert st["deposit_returned"] is True and st["exit_inventory"] is False and st["keys_returned"] is False
    m = assert_ok(c(client, "PATCH", f"/v1/households/{h}/move-out/keys_returned", a, {"done": True}), 200)["data"]["move_out"]
    assert {x["key"]: x["done"] for x in m["items"]}["keys_returned"] is True
    assert_error(c(client, "PATCH", f"/v1/households/{h}/move-out/exit_inventory", a, {"done": True}), 422, "VALIDATION_FAILED")
    assert_error(c(client, "GET", f"/v1/households/{h}/move-out", o), 403, "FORBIDDEN")


def test_exit_inventory_comparison(client, p10):
    a, h = p10["a"], p10["h"]
    mk = lambda kind, items: assert_ok(c(client, "POST", f"/v1/households/{h}/documents", a, {"kind": kind, "language": "fr",
                                                                                              "values": {"date": "2026-11-01", "items": items}}), 201)["data"]
    mk("inventory_entry", [{"room": "Chambre", "item": "Lit", "condition": "bon"}, {"room": "Cuisine", "item": "Frigo", "condition": "neuf"}])
    ex = mk("inventory_exit", [{"room": "Chambre", "item": "Lit", "condition": "bon"}, {"room": "Cuisine", "item": "Frigo", "condition": "porte cassée"}])
    cmp = assert_ok(c(client, "GET", f"/v1/documents/{ex['document_id']}/comparison", p10["owner"]), 200, "DocumentComparisonResponse")["data"]
    assert {r["item"]: r["state"] for r in cmp["rows"]} == {"Lit": "same", "Frigo": "changed"} and cmp["changed"] == 1
    m = assert_ok(c(client, "GET", f"/v1/households/{h}/move-out", a), 200)["data"]["move_out"]
    assert {x["key"]: x["done"] for x in m["items"]}["exit_inventory"] is True


def test_delete_my_account(client, p10):
    g, h, db = p10["gone"], p10["h"], p10["db"]
    assert_ok(c(client, "PUT", f"/v1/households/{h}/rules", g, {"items": [{"category": "quiet", "text": "Calme après 22 h"}]}), 200)
    doc = assert_ok(c(client, "POST", f"/v1/households/{h}/documents", g, {"kind": "house_rules", "language": "fr"}), 201)["data"]
    assert_error(c(client, "DELETE", "/v1/me", g, params={"confirm": "no"}), 422, "VALIDATION_FAILED")
    r = assert_ok(c(client, "DELETE", "/v1/me", g, params={"confirm": "DELETE"}), 200, "MeDeletedResponse")["data"]
    assert r["erased"] is True
    row = db.execute("select email, display_name, external_auth_id, deleted_at is not null from app.users where id = %s", (g,)).fetchone()
    assert row == (None, None, None, True)
    assert_error(c(client, "GET", f"/v1/documents/{doc['document_id']}", p10["a"]), 404, "NOT_FOUND")
    job = db.execute("""select input->'storage_keys' from app.jobs where type = 'delete_media' and idempotency_key = %s""",
                     ("erase-hdocs-" + g,)).fetchone()
    assert job and len(job[0]) == 1 and job[0][0].startswith("documents/"), "the PDF is queued for deletion (wf.ops.retention)"
    names = [m["display_name"] for m in assert_ok(c(client, "GET", f"/v1/households/{h}", p10["a"]), 200)["data"]["members"]]
    assert "Ghada" not in names
