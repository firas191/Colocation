"""Text service unit and HTTP tests (spec 15.1 'Service' layer). Messages here are written for the tests and are
not golden-set items; all personal values are invented."""
import os

import pytest
from fastapi.testclient import TestClient

import langid
import pii

TOKEN = "k" * 32


@pytest.fixture(scope="module")
def client():
    os.environ.update({"INTERNAL_SERVICE_TOKEN": TOKEN, "TEXT_WARM": "0"})
    import app
    return TestClient(app.app)


@pytest.mark.parametrize("text,script", [
    ("Je cherche une chambre calme", "latin"),
    ("أبحث عن غرفة قريبة من الجامعة", "arabic"),
    ("نحب studio قريب من la fac de droit", "mixed"),
    ("1234 5678", "other"),
])
def test_script(text, script):
    assert langid.script_of(text)[0] == script


@pytest.mark.parametrize("text", ["5allini nchouf el bit ghodwa", "9addech el kra fel chhar", "ena ne5dem bel lil w n7eb bit 9rib"])
def test_arabizi_detected(text):
    assert langid.arabizi_score(text) >= 0.2
    assert langid.identify(text)["language"] == "aeb"


@pytest.mark.parametrize("text", ["I need a room near the station from March", "Chambre meublée proche du tram, libre en mars",
                                  "Studio in Leeds, 2 min walk to campus"])
def test_not_arabizi(text):
    assert langid.arabizi_score(text) < 0.2


def test_tunisian_vs_msa_words():
    tn, msa = langid.tunisian_arabic_score("نحب بيت قريب باش نخدم توا")
    assert tn > msa
    tn, msa = langid.tunisian_arabic_score("أبحث عن غرفة هل يحق للمالك ذلك")
    assert msa > tn


def test_mixed_two_languages_with_whole_clauses():
    r = langid.identify("Bonjour, je cherche une chambre meublée près du centre. n7eb bit 9rib mel fac w kra mouch ghali barcha.")
    assert r["language"] == "mixed", r


@pytest.mark.parametrize("text,typ", [
    ("écris-moi à sami.test@example.com stp", "EMAIL"),
    ("mon numéro +216 22 345 678", "PHONE"),
    ("appelle 98.765.432 ce soir", "PHONE"),
    ("call me on 07700 900123", "PHONE"),
    ("carte 4111 1111 1111 1111 exp 12/29", "CARD"),
    ("IBAN FR76 3000 6000 0112 3456 7890 189 merci", "IBAN"),
    ("NI number AB 12 34 56 C", "ID"),
    ("mon CIN 07345612", "ID"),
    ("j'habite au 12 rue des Oliviers", "ADDRESS"),
    ("flat at 44 Station Road, M14 6HR", "ADDRESS"),
    ("الدار في نهج الياسمين عدد 4", "ADDRESS"),
    ("je m'appelle Leila Haddad", "NAME"),
    ("اسمي سامي", "NAME"),
])
def test_recognisers(text, typ):
    types = [e["type"] for e in pii.mask(text, use_ner=False)["entities"]]
    assert typ in types, (text, types)


@pytest.mark.parametrize("text", [
    "loyer 450000 millimes, libre le 15/11/2026, S+2 au 3e étage",
    "rent £650 pcm, bills 120, from 01/09/2026",
    "carte 4111 1111 1111 1112",                   # Luhn fails
    "IBAN FR76 3000 6000 0112 3456 7890 188",      # check digits fail
    "année universitaire 2026 2027, 20 min du campus",
])
def test_not_pii(text):
    assert pii.mask(text, use_ner=False)["entities"] == [], text


def test_placeholders_are_stable_and_mapping_is_returned():
    r = pii.mask("Sami: +216 22 345 678. Encore: +216 22 345 678, ou 98 111 222.", use_ner=False)
    assert r["masked_text"].count("[PHONE_1]") == 2 and "[PHONE_2]" in r["masked_text"]
    assert r["mapping"]["[PHONE_1]"] == "+216 22 345 678"
    assert "22 345 678" not in r["masked_text"]


def test_http(client):
    assert client.post("/v1/pii/mask", json={"text": "x"}).status_code == 401
    h = {"X-Internal-Token": TOKEN}
    r = client.post("/v1/analyze", json={"text": "slm, n7eb bit fi Ennasr, kalemni 3al 22 345 678"}, headers=h)
    assert r.status_code == 200
    j = r.json()
    assert j["language"]["language"] == "aeb" and j["pii"]["counts"] == {"PHONE": 1}
    assert client.post("/v1/lang", json={"text": ""}, headers=h).status_code == 422
    assert client.post("/v1/lang", json={"text": "a" * 20001}, headers=h).status_code == 422


def test_ner_model_that_fails_to_load_does_not_stop_the_service(tmp_path, monkeypatch):
    """F-057: a model directory that cannot be loaded is reported, and masking works without it."""
    (tmp_path / "config.json").write_text("{not json")
    monkeypatch.setenv("NER_MODEL", str(tmp_path))
    pii.ner.cache_clear()
    monkeypatch.setattr(pii, "NER_ERROR", None)
    try:
        r = pii.mask("Contact: test@example.com", use_ner=True)
        assert r["ner"] is False and r["ner_error"]
        assert [e["type"] for e in r["entities"]] == ["EMAIL"]
        assert "ner_error" not in pii.mask("Contact: test@example.com", use_ner=False)
    finally:
        pii.ner.cache_clear()
