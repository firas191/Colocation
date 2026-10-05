#!/usr/bin/env python3
"""Builds eval/datasets/pii_heldout_v1.jsonl: a second PII set written AFTER the recognisers were tuned on
pii_v1 (three runs, reports/phase4/01..03), with new sentence shapes, and scored once without further tuning
(D-075). Same generators for values as build_pii_v1.py (invented values, valid check digits), different
templates: names without a cue phrase, numbers inside longer sentences, upper-case e-mails, addresses with
apartment details, Arabic-script phone numbers written after the text, and new negatives.
Run: python eval/datasets/build_pii_heldout_v1.py   (seed 20261005)
"""
import json
import random
from pathlib import Path

import build_pii_v1 as b

b.rng = random.Random(20261005)
OUT = Path(__file__).with_name("pii_heldout_v1.jsonl")
r = b.rng
T = [
    ("fr", ["Pour visiter, ", ("NAME", b.name), " sera sur place samedi, son portable : ", ("PHONE", b.phone_tn), "."]),
    ("fr", ["Écrivez à ", ("EMAIL", lambda: b.email(r.choice(b.FIRST), r.choice(b.LAST)).upper()), " en précisant la date d'entrée."]),
    ("fr", ["Adresse : ", ("ADDRESS", lambda: f"{r.randint(2, 80)} {r.choice(b.STREETS_FR)}"), ", appartement 4, digicode 1234."]),
    ("fr", ["Le propriétaire, ", ("NAME", lambda: f"{r.choice(b.FIRST)} {r.choice(b.LAST)}"), ", préfère les virements : ", ("IBAN", lambda: b.iban("TN")), "."]),
    ("en", [("NAME", b.name), " here, still looking for a flatmate. WhatsApp ", ("PHONE", b.phone_gb), " anytime."]),
    ("en", ["Landlord details: ", ("NAME", b.name), ", ", ("ADDRESS", lambda: f"{r.randint(1, 200)} {r.choice(b.STREETS_EN)}"), ", ", ("POSTCODE", lambda: r.choice(b.UK_POSTCODES)), "."]),
    ("en", ["Pay the holding fee with card ", ("CARD", b.card), " or bank transfer."]),
    ("ar", ["للاتصال بالمالك ", ("NAME", lambda: f"{r.choice(b.FIRST_AR)} {r.choice(b.LAST_AR)}"), " على الرقم ", ("PHONE", b.phone_tn), " مساء."]),
    ("aeb_arabic", ["ابعث الفلوس على ", ("IBAN", lambda: b.iban("TN")), " وكلمني على ", ("PHONE", b.phone_tn), "."]),
    ("aeb_latin", ["5alli num mte3ek, mte3i ", ("PHONE", b.phone_tn), ", w el mail ", ("EMAIL", lambda: b.email(r.choice(b.FIRST), r.choice(b.LAST))), "."]),
    ("mixed", ["Bonsoir, ana ", ("NAME", lambda: r.choice(b.FIRST)), ", el CIN mte3i ", ("ID", b.cin), " pour le contrat."]),
    ("mixed", ["Salut, b3athtlek el adresse: ", ("ADDRESS", lambda: f"{r.randint(1, 50)} {r.choice(b.STREETS_FR)}"), ", 9rib mel pharmacie."]),
]
NEG = [
    ("fr", "Chambre 12 m2, loyer 380 DT, caution 760 DT, disponible du 01/12/2026 au 30/06/2027."),
    ("en", "Rent is 1,150 pounds, deposit 1,326, minimum term 6 months, viewing on 14 November at 18:30."),
    ("aeb_latin", "kra 600 dt, 3 bit, salon, cuisine équipée, 7 min mel métro ligne 4."),
    ("ar", "الشقة في الطابق 3، مساحة 85 متر مربع، الكراء 950 دينار، الضمان شهرين."),
    ("fr", "Résidence construite en 2019, 24 logements, ascenseur, parking n° 17."),
]


def build():
    rows, n = [], 0
    for _ in range(4):
        for lang, parts in T:
            text, spans = "", []
            for p in parts:
                if isinstance(p, str):
                    text += p
                else:
                    v = p[1]()
                    spans.append({"type": p[0], "start": len(text), "end": len(text) + len(v), "text": v})
                    text += v
            n += 1
            rows.append({"id": f"pii-h{n:03d}", "lang": lang, "text": text, "spans": spans})
    for lang, text in NEG:
        n += 1
        rows.append({"id": f"pii-h{n:03d}", "lang": lang, "text": text, "spans": [], "tags": ["negative"]})
    return rows


if __name__ == "__main__":
    rows = build()
    OUT.write_text("".join(json.dumps(x, ensure_ascii=False) + "\n" for x in rows), encoding="utf-8")
    print(f"wrote {OUT} ({len(rows)} rows, {sum(len(x['spans']) for x in rows)} spans)")
