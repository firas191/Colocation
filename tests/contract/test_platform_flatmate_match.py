"""Platform P12, D-115: the parts of Yosr's roommate matching (branch roommate-matching) rebuilt on the platform. Contact
requests with mutual consent, the sentence for a match, the profile agent A7 and the living plan. The model is the
sandbox mock (tests/mocks/deps_mock.py: flatmate_answer, the "sentence" format), so the tests that read its answers are
sandbox only. Country TN (the living plan prints dinars).
"""
import os
import sys
import uuid
from pathlib import Path

import psycopg
import pytest

from conftest import assert_error, assert_ok, sandbox_only
from test_platform_documents import pdf_text
from test_profile_search import make_user


def idem():
    return "t-" + uuid.uuid4().hex


def c(client, method, path, uid, body=None, params=None):
    return client.call(method, path, user_id=uid, body=body, params=params, idem=idem() if method != "GET" else None)


@pytest.fixture(scope="module")
def m(client):
    db = psycopg.connect(os.environ["FS_TEST_DB_DSN"], autocommit=True)
    sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "scripts"))
    import prompts as registry
    registry.sync(db)                                       # P12_match_explainer, P13_flatmate_onboarding active
    u = {k: make_user(db, "user", ("terms", "privacy"), jurisdiction="TN") for k in ("amira", "sarra", "yassine", "dora")}
    for k in u:
        db.execute("update app.users set display_name = %s where id = %s", (k.title(), u[k]))
    for k in ("amira", "sarra", "yassine"):
        assert_ok(c(client, "PUT", "/v1/me/flatmate-profile", u[k], {"visible": True, "headline": f"Profil de {k}"}), 200)
    keep = db.execute("select value from app.settings where key = 'flatmate_explain.enabled'").fetchone()[0]
    yield {"db": db, **u}
    db.execute("update app.settings set value = %s where key = 'flatmate_explain.enabled'", (psycopg.types.json.Jsonb(keep),))
    db.execute("delete from app.rate_counters where bucket like 'ip:%'")
    db.close()


def test_contact_needs_both_to_agree(client, m):
    a, s, y = m["amira"], m["sarra"], m["yassine"]
    r = assert_ok(c(client, "POST", f"/v1/flatmates/{s}/contact-requests", a, {"note": "Bonjour Sarra, on cherche à Ariana toutes les deux ?"}),
                  201, "ContactRequestResponse")["data"]
    assert r["direction"] == "sent" and r["status"] == "pending" and r["actions"]["cancel"] is True
    assert_error(c(client, "POST", f"/v1/flatmates/{a}/contact-requests", s, {}), 409, "CONFLICT")
    assert_error(c(client, "POST", f"/v1/flatmates/{m['dora']}/contact-requests", a, {}), 404, "NOT_FOUND")   # no visible profile
    got = assert_ok(c(client, "GET", "/v1/me/contact-requests", s, params={"direction": "received"}), 200, "ContactRequestsResponse")["data"]["items"]
    mine = next(x for x in got if x["request_id"] == r["request_id"])
    assert mine["actions"]["accept"] is True and mine["other"]["display_name"] == "Amira"
    assert_error(c(client, "POST", f"/v1/contact-requests/{r['request_id']}/decision", a, {"action": "accept"}), 403, "FORBIDDEN")
    assert_error(c(client, "POST", f"/v1/contact-requests/{r['request_id']}/decision", y, {"action": "accept"}), 404, "NOT_FOUND")
    before = assert_ok(c(client, "GET", "/v1/conversations", a), 200)["data"]["items"]
    assert not [x for x in before if x["kind"] == "direct" and (x["other"] or {}).get("user_id") == s], "no conversation before she accepts"
    d = assert_ok(c(client, "POST", f"/v1/contact-requests/{r['request_id']}/decision", s, {"action": "accept"}), 200, "ContactRequestResponse")["data"]
    assert d["status"] == "accepted" and d["conversation_id"]
    convs = assert_ok(c(client, "GET", "/v1/conversations", a), 200, "ConversationsResponse")["data"]["items"]
    conv = next(x for x in convs if x["conversation_id"] == d["conversation_id"])
    assert conv["kind"] == "direct" and conv["listing"] is None and conv["other"]["user_id"] == s
    msgs = assert_ok(c(client, "GET", f"/v1/conversations/{d['conversation_id']}/messages", s), 200)["data"]["items"]
    assert [x["body"] for x in msgs] == ["Bonjour Sarra, on cherche à Ariana toutes les deux ?"] and msgs[0]["mine"] is False
    n = assert_ok(c(client, "GET", "/v1/me/notifications", a), 200)["data"]["items"]
    assert any(x["type"] == "contact_request_accepted" for x in n)
    assert_error(c(client, "POST", f"/v1/contact-requests/{r['request_id']}/decision", s, {"action": "refuse"}), 409, "CONFLICT")


def test_refuse_and_cancel(client, m):
    a, y = m["amira"], m["yassine"]
    r = assert_ok(c(client, "POST", f"/v1/flatmates/{a}/contact-requests", y, {}), 201)["data"]
    assert assert_ok(c(client, "POST", f"/v1/contact-requests/{r['request_id']}/decision", a, {"action": "refuse"}), 200)["data"]["status"] == "refused"
    r2 = assert_ok(c(client, "POST", f"/v1/flatmates/{a}/contact-requests", y, {"note": "Encore moi"}), 201)["data"]
    assert assert_ok(c(client, "POST", f"/v1/contact-requests/{r2['request_id']}/decision", y, {"action": "cancel"}), 200)["data"]["status"] == "cancelled"
    assert_error(c(client, "POST", f"/v1/contact-requests/{r2['request_id']}/decision", y, {"action": "maybe"}), 422, "VALIDATION_FAILED")


def test_profile_by_chat_then_apply(client, m):
    """The agent's answers go through the code checks; the person saves them. (The agent's part reads the mock.)"""
    a = m["amira"]
    st = assert_ok(c(client, "POST", "/v1/me/flatmate-profile/apply", a, {"lifestyle": {"smoking": "no", "pets": "no", "schedule": "early"},
                                                                         "budget_max": 400, "areas": ["Ariana"], "move_in_from": "2026-12-01"}),
                   200, "FlatmateOnboardingStateResponse")["data"]
    assert st["lifestyle"] == {"smoking": "no", "pets": "no", "schedule": "early"} and st["budget"]["max_minor"] == 400000
    assert "areas" not in st["missing"] and "cleanliness" in st["missing"]
    assert_error(c(client, "POST", "/v1/me/flatmate-profile/apply", a, {"lifestyle": {"smoking": "sometimes"}}), 422, "VALIDATION_FAILED")
    me = assert_ok(c(client, "GET", "/v1/me/flatmate-profile", a), 200)["data"]["profile"]
    assert me["areas"] == ["Ariana"] and me["headline"] == "Profil de amira", "fields not given stay"


@sandbox_only
def test_profile_agent_proposes_only_what_was_written(client, m):
    s = m["sarra"]
    r = assert_ok(c(client, "POST", "/v1/me/flatmate-profile/assistant", s,
                    {"text": "Je cherche une chambre à La Marsa, 450 dt maximum, non-fumeuse, pas d'animaux."}), 200, "FlatmateAssistantResponse")["data"]
    assert r["proposal"] == {"lifestyle": {"smoking": "no", "pets": "no"}, "budget_max": 450, "areas": ["La Marsa"]}, r
    assert "Enregistrer" in r["answer"]
    # the mock also proposes a budget of 999 and the area Carthage, which nobody wrote: code drops both
    r = assert_ok(c(client, "POST", "/v1/me/flatmate-profile/assistant", s, {"text": "Je suis couche-tard. [mock:invent]"}), 200)["data"]
    assert r["proposal"] == {"lifestyle": {"schedule": "late"}}, r
    assert {"field": "areas", "value": "Carthage", "why": "not_in_text"} in r["dropped"]
    assert {"field": "budget_max", "why": "not_in_text"} in r["dropped"]
    steps = m["db"].execute("""select s.agent, s.output from ai.agent_steps s join ai.executions e on e.id = s.execution_id
                                where e.user_id = %s and s.agent = 'A7_flatmate_agent'""", (s,)).fetchall()
    assert steps and "La Marsa" not in str(steps), "the trace keeps no text of the person"


def test_explanation_by_code_when_the_model_is_off(client, m):
    a, s, db = m["amira"], m["sarra"], m["db"]
    assert_ok(c(client, "POST", "/v1/me/flatmate-profile/apply", s, {"lifestyle": {"smoking": "no", "pets": "yes"}}), 200)
    db.execute("update app.settings set value = 'false' where key = 'flatmate_explain.enabled'")
    try:
        e = assert_ok(c(client, "POST", f"/v1/flatmates/{s}/explanation", a, {"language": "fr"}), 200, "FlatmateExplanationResponse")["data"]
    finally:
        db.execute("update app.settings set value = 'true' where key = 'flatmate_explain.enabled'")
    assert e["source"] == "code" and e["sentence"] == "Vous vous accordez sur : le tabac. À discuter : les animaux.", e
    assert "yes" not in str(e), "the other person's answers are not given"


@sandbox_only
def test_explanation_by_the_model_and_its_check(client, m):
    a, s, db = m["amira"], m["sarra"], m["db"]
    e = assert_ok(c(client, "POST", f"/v1/flatmates/{s}/explanation", a, {"language": "fr"}), 200)["data"]
    assert e["source"] == "model" and "tabac" in e["sentence"], e
    db.execute("update app.users set display_name = 'Badnum' where id = %s", (s,))
    try:
        e = assert_ok(c(client, "POST", f"/v1/flatmates/{s}/explanation", a, {"language": "fr"}), 200)["data"]
    finally:
        db.execute("update app.users set display_name = 'Sarra' where id = %s", (s,))
    assert e["source"] == "code", "a number that is not the score: the code's sentence"


def test_living_plan(client, m):
    a, s = m["amira"], m["sarra"]
    h = assert_ok(c(client, "POST", "/v1/households", a, {"name": "Dar Match", "jurisdiction_code": "TN"}), 201)["data"]["household_id"]
    code = assert_ok(c(client, "POST", f"/v1/households/{h}/invites", a, {}), 201)["data"]["code"]
    assert_ok(c(client, "POST", "/v1/household-invites/accept", s, {"code": code}), 200)
    assert_ok(c(client, "PUT", f"/v1/households/{h}/recurring", a, {"items": [
        {"kind": "rent", "label": "Loyer", "amount_minor": 900000, "due_day": 25, "remind_days_before": 2}]}), 200)
    # (not the 5th with 3 days: home.daily_reminders counts every household, and test_platform_household checks 2 January)
    assert_ok(c(client, "POST", f"/v1/households/{h}/chores", a, {"title": "Poubelles", "frequency": "weekly", "next_due_on": "2026-11-02"}), 201)
    d = assert_ok(c(client, "POST", f"/v1/households/{h}/documents", s, {"kind": "living_plan", "language": "en",
                                                                         "values": {"start_date": "2026-11-01"}}), 201, "DocumentResponse")["data"]
    assert d["status"] == "ready" and d["template"]["key"] == "global.living_plan"
    text = pdf_text(assert_ok(c(client, "GET", f"/v1/documents/{d['document_id']}", a), 200)["data"]["download"]["url"])
    for want in ("Living plan", "Dar Match", "Agreed: no", "To discuss: the answers differ", "Not said by everyone yet",
                 "900.000 TND", "450.000 TND", "Poubelles", "every week", "2026-11-01"):
        assert want in text, want
    assert "Amira" not in text.split("How each person lives")[1].split("Rent and bills")[0], "nobody's answers by name"
