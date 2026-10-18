"""Platform P9 (docs/PLATFORM_SPEC.md 3.7, 3.8, 9 P9; D-108): document templates per country, documents rendered to
PDF (Media service, WeasyPrint), the Document agent A6 (sandbox mock model) and POST /v1/legal/ask. A TN household
with two flatmates and the owner member; the rent receipt comes from a payment the owner member confirmed.
"""
import io
import os
import sys
import uuid
from pathlib import Path

import psycopg
import pytest

import httpx

from conftest import assert_error, assert_ok, sandbox_only
from test_platform_search import fetch
from test_profile_search import make_user


def idem():
    return "t-" + uuid.uuid4().hex


def c(client, method, path, uid, body=None, params=None):
    return client.call(method, path, user_id=uid, body=body, params=params, idem=idem() if method != "GET" else None)


@pytest.fixture(scope="module")
def p9(client):
    db = psycopg.connect(os.environ["FS_TEST_DB_DSN"], autocommit=True)
    sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "scripts"))
    import prompts as registry
    registry.sync(db)                                              # P9_document_agent v1 active
    u = {k: make_user(db, "user", ("terms", "privacy"), jurisdiction="TN") for k in ("a", "b", "owner", "outsider")}
    for k, name in (("a", "Amel"), ("b", "Bilel"), ("owner", "Omar")):           # names printed on the documents
        db.execute("update app.users set display_name = %s where id = %s", (name, u[k]))
    h = assert_ok(c(client, "POST", "/v1/households", u["a"], {"name": "Dar Yasmine", "jurisdiction_code": "TN",
                                                               "address_text": "12 rue des Oliviers, Ariana"}), 201)["data"]["household_id"]
    for k, role in (("b", "flatmate"), ("owner", "owner")):
        code = assert_ok(c(client, "POST", f"/v1/households/{h}/invites", u["a"], {"role": role}), 201)["data"]["code"]
        assert_ok(c(client, "POST", "/v1/household-invites/accept", u[k], {"code": code}), 200)
    yield {"db": db, "h": h, **u}
    db.execute("delete from app.rate_counters where bucket like 'ip:%'")
    db.close()


def pdf_text(url):
    import pdfplumber
    r = fetch(url)
    assert r.status_code == 200 and r.content[:5] == b"%PDF-"
    with pdfplumber.open(io.BytesIO(r.content)) as pdf:
        return "\n".join(p.extract_text() or "" for p in pdf.pages)


def test_templates_per_country(client, p9):
    tn = assert_ok(c(client, "GET", "/v1/document-templates", p9["a"], params={"jurisdiction": "TN"}), 200, "DocumentTemplatesResponse")["data"]
    assert sorted(t["kind"] for t in tn["items"]) == ["flatmate_agreement", "house_rules", "inventory_entry", "inventory_exit",
                                                         "living_plan", "rent_receipt"]          # living_plan: D-115
    assert all(s["url"].startswith("https://") and s["retrieved_at"] for t in tn["items"] if t["legal"] for s in t["sources"])
    fr = assert_ok(c(client, "GET", "/v1/document-templates", p9["a"], params={"jurisdiction": "FR"}), 200)["data"]
    assert sorted(t["kind"] for t in fr["items"]) == ["house_rules", "living_plan"] and "rent_receipt" in fr["not_available"]


def test_inventory_pdf_with_sources_and_missing_slots(client, p9):
    h, a = p9["h"], p9["a"]
    r = assert_error(c(client, "POST", f"/v1/households/{h}/documents", a, {"kind": "inventory_entry", "language": "fr", "values": {}}),
                     422, "VALIDATION_FAILED")
    assert {d["field"] for d in r["error"]["details"]} == {"date", "items"}, "each missing slot is named"
    items = [{"room": "Chambre", "item": "Lit", "condition": "bon", "notes": "<b>tache</b>"}, {"room": "Cuisine", "item": "Frigo", "condition": "neuf"}]
    d = assert_ok(c(client, "POST", f"/v1/households/{h}/documents", a, {"kind": "inventory_entry", "language": "fr",
                    "values": {"date": "2026-11-01", "items": items, "penalty_clause": "Le locataire renonce à tout recours"}}),
                  201, "DocumentResponse")["data"]
    assert d["status"] == "ready" and d["template"]["key"] == "tn.inventory_entry" and d["dropped"] == ["penalty_clause"]
    g = assert_ok(c(client, "GET", f"/v1/documents/{d['document_id']}", p9["owner"]), 200, "DocumentResponse")["data"]
    text = pdf_text(g["download"]["url"])
    assert "État des lieux d'entrée" in text and "Ariana" in text and "Frigo" in text and "<b>tache</b>" in text
    assert "COC art. 780-783" in text and "2026-10-17" in text and "documents-notice-v1" in text
    assert "renonce" not in text, "a value for an unknown slot never reaches the PDF"
    assert_error(c(client, "GET", f"/v1/documents/{d['document_id']}", p9["outsider"]), 404, "NOT_FOUND")
    lst = assert_ok(c(client, "GET", f"/v1/households/{h}/documents", p9["b"]), 200, "DocumentsResponse")["data"]["items"]
    assert any(x["document_id"] == d["document_id"] for x in lst)


def test_rent_receipt_from_a_confirmed_payment_in_arabic(client, p9):
    h, b, o = p9["h"], p9["b"], p9["owner"]
    pay = assert_ok(c(client, "POST", f"/v1/households/{h}/rent-payments", b, {"period": "2026-11", "amount_minor": 450000}), 201)["data"]
    assert_error(c(client, "POST", f"/v1/households/{h}/documents", o, {"kind": "rent_receipt", "language": "ar", "payment_id": pay["payment_id"]}),
                 422, "VALIDATION_FAILED")
    assert_ok(c(client, "POST", f"/v1/rent-payments/{pay['payment_id']}/confirm", o, {}), 200)
    assert_error(c(client, "POST", f"/v1/households/{h}/documents", b, {"kind": "rent_receipt", "language": "ar", "payment_id": pay["payment_id"]}),
                 403, "FORBIDDEN")
    d = assert_ok(c(client, "POST", f"/v1/households/{h}/documents", o, {"kind": "rent_receipt", "language": "ar", "payment_id": pay["payment_id"]}),
                  201)["data"]
    text = pdf_text(assert_ok(c(client, "GET", f"/v1/documents/{d['document_id']}", b), 200)["data"]["download"]["url"])
    assert "450.000 TND" in text and "2026-11" in text and "COC art. 768-770" in text


@sandbox_only
def test_document_agent_proposes_then_the_person_confirms(client, p9):
    """What the Document agent proposes is the mock's answer here; on the PC the document bench measures it."""
    h, a = p9["h"], p9["a"]
    r = c(client, "POST", f"/v1/households/{h}/documents/assistant", a,
          {"text": "Fais-moi un contrat de colocation à partir du 2026-12-01, préavis 30 jours, Amel 225 dt et Bilel 225 dt [mock:extra]"})
    j = assert_ok(r, 200, "DocumentAssistantResponse")["data"]
    dr = j["draft"]
    assert dr["kind"] == "flatmate_agreement" and dr["missing"] == [] and j["answer"]
    assert "penalty_clause" not in dr["values"], "a value for a slot the template does not have is dropped"
    assert dr["values"]["notice_days"] == 30 and len(dr["values"]["shares"]) == 2
    d = assert_ok(c(client, "POST", f"/v1/households/{h}/documents", a, {"draft_id": dr["draft_id"]}), 201)["data"]
    text = pdf_text(assert_ok(c(client, "GET", f"/v1/documents/{d['document_id']}", a), 200)["data"]["download"]["url"])
    assert "Accord de colocation" in text and "30 jours" in text and "COC art. 772-774" in text
    assert_error(c(client, "POST", f"/v1/households/{h}/documents", a, {"draft_id": dr["draft_id"]}), 404, "NOT_FOUND"), "a draft is used once"
    assert_error(c(client, "POST", f"/v1/households/{h}/documents/assistant", p9["outsider"], {"text": "contrat"}), 404, "NOT_FOUND")


def test_legal_ask_goes_to_the_legal_agent(client, p9):
    # the Legal agent on the PC's local model takes longer than the client's usual 30 s; the website's route waits
    # longer than the API's 120 s model timeout (PLATFORM_SPEC 6.6), so does this call
    keep = client.http.timeout
    client.http.timeout = httpx.Timeout(180)
    try:
        r = c(client, "POST", "/v1/legal/ask", p9["a"], {"text": "Le bailleur peut-il garder la caution ?", "jurisdiction": "TN"})
    finally:
        client.http.timeout = keep
    assert r.status_code in (200, 503), r.text
    if r.status_code == 200:
        d = assert_ok(r, 200, "LegalAskResponse")["data"]
        assert d["status"] in ("answered", "abstained") and d["jurisdiction"] == "TN"
    assert_error(c(client, "POST", "/v1/legal/ask", p9["a"], {"text": ""}), 422, "VALIDATION_FAILED")
