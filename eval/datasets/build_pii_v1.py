#!/usr/bin/env python3
"""Builds eval/datasets/pii_v1.jsonl: a labelled set for PII masking recall (spec 2.6 target 0.98, spec 13.2).

Synthetic and template-based (D-075): every value is invented (names are common first names and surnames, phone
numbers random, e-mail domains example.* / *.test, IBANs and card numbers generated with valid check digits but
belonging to nobody). Labels come from construction, so offsets are exact. Templates cover French, English, Modern
Standard Arabic, Tunisian in Arabic script and in Latin letters, and code-switched text, plus messages with numbers
that are NOT personal data (prices, dates, room counts, postcodes alone, years), to measure over-masking.
Being templated, the set is cleaner than real messages; reports say so.

Run: python eval/datasets/build_pii_v1.py   (deterministic, seed 20261004)
"""
import json
import random
from pathlib import Path

from schwifty import IBAN

OUT = Path(__file__).with_name("pii_v1.jsonl")
rng = random.Random(20261004)

FIRST = ["Sami", "Amira", "Youssef", "Ines", "Mehdi", "Salma", "Karim", "Nour", "Hamza", "Rania", "Julien", "Claire",
         "Thomas", "Camille", "James", "Emily", "Oliver", "Sophie", "Aziz", "Lina"]
LAST = ["Ben Salah", "Trabelsi", "Gharbi", "Jlassi", "Mansouri", "Dupont", "Martin", "Lefebvre", "Smith", "Taylor", "Brown",
        "Haddad", "Bouzid", "Chaabane"]
FIRST_AR = ["سامي", "أميرة", "يوسف", "إيناس", "مهدي", "سلمى", "كريم", "نور", "حمزة", "رانية"]
LAST_AR = ["بن صالح", "الطرابلسي", "الغربي", "الجلاصي", "المنصوري", "حداد"]
STREETS_FR = ["rue de Marseille", "avenue Habib Bourguiba", "rue Ibn Khaldoun", "boulevard de l'Environnement", "rue des Jasmins",
              "avenue de la Liberté", "rue Victor Hugo"]
STREETS_EN = ["Oxford Road", "Wilmslow Road", "Victoria Street", "Kings Avenue", "Mill Lane", "Station Road"]
STREETS_AR = ["نهج الحرية", "شارع الحبيب بورقيبة", "نهج ابن خلدون", "شارع فرحات حشاد", "نهج مرسيليا"]
STREETS_AZ = ["nahj el hourriya", "nahj ibn khaldoun", "nahj marseille"]
UK_POSTCODES = ["M14 6HR", "LS6 2AB", "SW1A 1AA", "B15 2TT", "E14 5AB"]


def phone_tn():
    p = rng.choice("2459") + "".join(rng.choice("0123456789") for _ in range(7))
    return rng.choice([f"+216 {p[:2]} {p[2:5]} {p[5:]}", f"{p[:2]} {p[2:5]} {p[5:]}", p, f"00216{p}", f"{p[:2]}.{p[2:5]}.{p[5:]}"])


def phone_fr():
    d = "".join(rng.choice("0123456789") for _ in range(8))
    m = rng.choice("67")
    return rng.choice([f"0{m} {d[:2]} {d[2:4]} {d[4:6]} {d[6:]}", f"+33 {m} {d[:2]} {d[2:4]} {d[4:6]} {d[6:]}", f"0{m}{d}"])


def phone_gb():
    d = "".join(rng.choice("0123456789") for _ in range(8))
    return rng.choice([f"07{d[:3]} {d[3:]}", f"+44 7{d[:3]} {d[3:]}", f"07{d}"])


def email(first, last):
    user = (first + "." + last.split()[-1]).lower().replace(" ", "")
    return f"{user}{rng.randint(1, 99)}@{rng.choice(['example.com', 'example.org', 'mail.test', 'example.tn'])}"


def iban(cc):
    bank = {"TN": "10006035", "FR": "2004101005", "GB": "NWBK601613"}[cc]
    if cc == "TN":
        acct = "".join(rng.choice("0123456789") for _ in range(12))
        i = IBAN.generate("TN", bank_code=bank[:2], branch_code=bank[2:5], account_code=acct + rng.choice("0123456789"))
    elif cc == "FR":
        i = IBAN.generate("FR", bank_code=bank[:5], branch_code=bank[5:], account_code="".join(rng.choice("0123456789") for _ in range(11)))
    else:
        i = IBAN.generate("GB", bank_code=bank[:4], branch_code=bank[4:], account_code="".join(rng.choice("0123456789") for _ in range(8)))
    s = str(i)
    return rng.choice([s, " ".join(s[k:k + 4] for k in range(0, len(s), 4))])


def card():
    base = [4] + [rng.randint(0, 9) for _ in range(14)]
    total = 0
    for k, dgt in enumerate(reversed(base)):
        x = dgt * 2 if k % 2 == 0 else dgt
        total += x - 9 if x > 9 else x
    s = "".join(map(str, base + [(10 - total % 10) % 10]))
    return rng.choice([s, " ".join(s[k:k + 4] for k in range(0, 16, 4)), "-".join(s[k:k + 4] for k in range(0, 16, 4))])


def nir():
    sex, yy, mm, dep, com, ordn = rng.choice("12"), f"{rng.randint(60, 99):02d}", f"{rng.randint(1, 12):02d}", f"{rng.randint(1, 95):02d}", f"{rng.randint(1, 999):03d}", f"{rng.randint(1, 999):03d}"
    n = int(sex + yy + mm + dep + com + ordn)
    key = 97 - n % 97
    return rng.choice([f"{sex} {yy} {mm} {dep} {com} {ordn} {key:02d}", f"{sex}{yy}{mm}{dep}{com}{ordn}{key:02d}"])


def nino():
    return f"{rng.choice(['AB', 'JK', 'PR', 'SH', 'WL'])} {rng.randint(10, 99)} {rng.randint(10, 99)} {rng.randint(10, 99)} {rng.choice('ABCD')}"


def cin():
    return rng.choice("01") + "".join(rng.choice("0123456789") for _ in range(7))


def name():
    return f"{rng.choice(FIRST)} {rng.choice(LAST)}"


# template: list of literal strings and (TYPE, generator) pairs; language tag
T = [
    ("fr", ["Bonjour, je m'appelle ", ("NAME", name), ", vous pouvez me joindre au ", ("PHONE", phone_tn), " pour la chambre."]),
    ("fr", ["Contactez ", ("NAME", lambda: rng.choice(FIRST)), " au ", ("PHONE", phone_tn), " ou par mail ", ("EMAIL", lambda: email(rng.choice(FIRST), rng.choice(LAST))), "."]),
    ("fr", ["L'appartement est au ", ("ADDRESS", lambda: f"{rng.randint(1, 120)} {rng.choice(STREETS_FR)}"), ", 3e étage, loyer 650 euros."]),
    ("fr", ["Pour la caution, virement sur ", ("IBAN", lambda: iban("FR")), " avant le 1er novembre."]),
    ("fr", ["Mon numéro de sécurité sociale est ", ("ID", nir), ", c'est pour le dossier."]),
    ("fr", ["Vous pouvez payer par carte ", ("CARD", card), ", expiration 09/28."]),
    ("fr", ["Je suis ", ("NAME", name), ", étudiant à l'INSAT, mon CIN ", ("ID", cin), "."]),
    ("fr", ["Appelez Mme ", ("NAME", lambda: rng.choice(LAST)), " au ", ("PHONE", phone_fr), " après 18h."]),
    ("en", ["Hi, my name is ", ("NAME", name), " and my number is ", ("PHONE", phone_gb), "."]),
    ("en", ["The flat is at ", ("ADDRESS", lambda: f"{rng.randint(1, 300)} {rng.choice(STREETS_EN)}"), ", ", ("POSTCODE", lambda: rng.choice(UK_POSTCODES)), ", rent £650 pcm."]),
    ("en", ["Please send the deposit to ", ("IBAN", lambda: iban("GB")), " and email me at ", ("EMAIL", lambda: email(rng.choice(FIRST), rng.choice(LAST))), "."]),
    ("en", ["My National Insurance number is ", ("ID", nino), " if the agency needs it."]),
    ("en", ["Text ", ("NAME", lambda: rng.choice(FIRST)), " on ", ("PHONE", phone_gb), " to arrange a viewing."]),
    ("ar", ["اسمي ", ("NAME", lambda: f"{rng.choice(FIRST_AR)} {rng.choice(LAST_AR)}"), " ورقم هاتفي ", ("PHONE", phone_tn), "."]),
    ("ar", ["الشقة في ", ("ADDRESS", lambda: f"{rng.choice(STREETS_AR)} عدد {rng.randint(1, 90)}"), " قرب المحطة، الكراء 500 دينار."]),
    ("ar", ["رقم بطاقة التعريف ", ("ID", cin), " والبريد ", ("EMAIL", lambda: email(rng.choice(FIRST), rng.choice(LAST))), "."]),
    ("aeb_arabic", ["كلمني على ", ("PHONE", phone_tn), " ولا ابعثلي على ", ("EMAIL", lambda: email(rng.choice(FIRST), rng.choice(LAST))), "."]),
    ("aeb_arabic", ["الدار في ", ("ADDRESS", lambda: f"{rng.choice(STREETS_AR)} عدد {rng.randint(1, 60)}"), "، اسأل على السيد ", ("NAME", lambda: rng.choice(FIRST_AR)), "."]),
    ("aeb_latin", ["slm, ena esmi ", ("NAME", lambda: rng.choice(FIRST)), ", 9oli 3al ", ("PHONE", phone_tn), " ken t7eb tchouf el bit."]),
    ("aeb_latin", ["el bit fi ", ("ADDRESS", lambda: f"{rng.choice(STREETS_AZ)} 3adad {rng.randint(1, 80)}"), ", kra 400 dt."]),
    ("aeb_latin", ["ab3ath el caution 3la ", ("IBAN", lambda: iban("TN")), " w ab3athli capture."]),
    ("mixed", ["Salut, n7eb nchouf el chambre, mon numéro ", ("PHONE", phone_tn), ", w esmi ", ("NAME", lambda: rng.choice(FIRST)), "."]),
    ("mixed", ["Bonjour, el dar fi ", ("ADDRESS", lambda: f"{rng.randint(1, 99)} {rng.choice(STREETS_FR)}"), ", appelle ", ("NAME", lambda: rng.choice(FIRST)), " 3al ", ("PHONE", phone_tn), "."]),
]
NEG = [
    ("fr", "Chambre meublée à 450000 millimes par mois, libre le 15/11/2026, 3 chambres, S+2 au 2e étage."),
    ("fr", "Budget entre 1 200 et 1 500 euros, dès janvier 2027, Paris 75013, 20 minutes du métro."),
    ("fr", "Studio de 25 m2 à Lac 2, loyer 900 DT charges comprises, caution 2 mois."),
    ("en", "Room in Fallowfield, £170 pw, bills included, available from 01/09/2026, 2 flatmates aged 22 and 24."),
    ("en", "The house has 4 bedrooms, 2 bathrooms, rent 2400 pounds a month, built in 1995."),
    ("ar", "شقة بثلاث غرف في المنزه 6، الكراء 1200 دينار، متاحة من 1 ديسمبر 2026."),
    ("aeb_arabic", "نلوج على بيت ب 350 دينار قريب من الفاك، من 15 نوفمبر، لمدة 9 شهر."),
    ("aeb_latin", "n7eb bit fi Ennasr 2, kra 500 alf, men awel decembre, 20 min mel ESPRIT."),
    ("aeb_latin", "bit b 380 dt, fama wifi, 2 colocataires, l'année universitaire 2026 2027."),
    ("mixed", "Bonjour, el studio b 1.200 dt, 45 m2, men 1er janvier, appartement n° 12 au 3e étage."),
    ("en", "Order 12345678 confirmed? No, just checking the 8 rooms listing and the 2026 lease."),
    ("fr", "Référence de l'annonce 20261104, prix 480 euros, code postal 69003 Lyon."),
]


def build():
    rows = []
    n = 0
    for rep in range(5):
        for lang, parts in T:
            text, spans = "", []
            for p in parts:
                if isinstance(p, str):
                    text += p
                else:
                    typ, gen = p
                    v = gen()
                    spans.append({"type": typ, "start": len(text), "end": len(text) + len(v), "text": v})
                    text += v
            n += 1
            rows.append({"id": f"pii-{n:03d}", "lang": lang, "text": text, "spans": spans})
    for lang, text in NEG:
        n += 1
        rows.append({"id": f"pii-{n:03d}", "lang": lang, "text": text, "spans": [], "tags": ["negative"]})
    return rows


if __name__ == "__main__":
    rows = build()
    OUT.write_text("".join(json.dumps(r, ensure_ascii=False) + "\n" for r in rows), encoding="utf-8")
    print(f"wrote {OUT} ({len(rows)} rows, {sum(len(r['spans']) for r in rows)} spans)")
