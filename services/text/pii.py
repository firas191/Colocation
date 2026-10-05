"""PII detection and masking (spec 13.2; Text service). Entities are replaced by stable placeholders
([PHONE_1], [NAME_2]); the same value gets the same placeholder within one request. The mapping is returned to the
caller for that request only and never stored by this service.

Recognisers (D-075):
- EMAIL: pattern.
- PHONE: `phonenumbers` matcher for TN, FR, GB and international formats, plus Tunisian 8-digit mobile/landline
  numbers written with spaces or dots that the matcher's leniency misses.
- CARD: 13 to 19 digits (spaces or dashes allowed) passing the Luhn check.
- IBAN: candidate pattern validated with `schwifty` (country length and check digits).
- ID: French NIR (`stdnum.fr.nir`), UK National Insurance number (pattern with the excluded prefixes; no checksum
  exists), Tunisian CIN (8 digits; no library found: next to an ID keyword, or starting with 0 or 1 when the
  number is not a phone number).
- ADDRESS: house number + street word (fr, en) or street word + name (Arabic and Tunisian: نهج, شارع, ...), and UK
  postcodes. No geocoder confirmation here (the service never queries the database, spec 5.1); this over-masks
  rather than under-masks.
- NAME: an optional NER model (transformers token classification) when configured, plus cue patterns that work
  without a model ("je m'appelle X", "my name is X", "esmi X", "اسمي X", titles such as M., Mme, Mr, Mrs, السيد).
Recall is measured on eval/datasets/pii_v1.jsonl (scripts/p4.py pii-eval), target 0.98 (spec 2.6).
"""
from __future__ import annotations

import logging
import os
import re
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path

import phonenumbers
from schwifty import IBAN
from stdnum.fr import nir as fr_nir
from stdnum import luhn

PRIORITY = {"EMAIL": 9, "IBAN": 8, "CARD": 7, "ID": 6, "PHONE": 5, "ADDRESS": 4, "POSTCODE": 3, "NAME": 2}


@dataclass
class Span:
    start: int
    end: int
    type: str
    value: str
    source: str
    score: float = 1.0


EMAIL_RE = re.compile(r"(?<![\w.+-])[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,253}\.[A-Za-z]{2,24}(?![\w-])")
CARD_RE = re.compile(r"(?<!\d)(?:\d[ -]?){12,18}\d(?!\d)")
IBAN_RE = re.compile(r"(?<![A-Z0-9])[A-Z]{2}\d{2}(?:[ ]?[A-Z0-9]){10,30}(?![A-Z0-9])", re.I)
NIR_RE = re.compile(r"(?<!\d)[12][ .]?\d{2}[ .]?(?:0[1-9]|1[0-2]|[2-9]\d)[ .]?(?:\d{2}|2[AB])[ .]?\d{3}[ .]?\d{3}(?:[ .]?\d{2})?(?!\d)", re.I)
NINO_RE = re.compile(r"(?<![A-Z0-9])(?!BG|GB|KN|NK|NT|TN|ZZ)[A-CEGHJ-PR-TW-Z][A-CEGHJ-NPR-TW-Z] ?\d{2} ?\d{2} ?\d{2} ?[A-D](?![A-Z0-9])", re.I)
# 8 digits standing alone: not part of a longer digit group ("06 84 87 20 82" is a French phone number, not a CIN)
EIGHT_RE = re.compile(r"(?<![\d+])(?<!\d[ .])(\d{8}|\d{2}[ .]\d{3}[ .]\d{3}|\d{2}[ .]\d{2}[ .]\d{2}[ .]\d{2})(?![ .]?\d)")
YEARS_RE = re.compile(r"(?:19|20)\d{2}(?:[ \-/]+(?:19|20)\d{2})+")
ID_CUE_RE = re.compile(r"(?i)\b(cin|c\.i\.n|carte d'identit[ée]|n[°o]\s*cin|id card|identity card|passport|passeport)\b|بطاقة التعريف|ب\.ت\.و|رقم البطاقة")
UK_POSTCODE_RE = re.compile(r"(?<![A-Z0-9])(?:GIR ?0AA|[A-PR-UWYZ](?:\d{1,2}|[A-HK-Y]\d{1,2}|\d[A-HJKSTUW]|[A-HK-Y]\d[ABEHMNPRV-Y]) ?\d[ABD-HJLNP-UW-Z]{2})(?![A-Z0-9])")
STREET_FR = r"(?:rue|avenue|av\.?|boulevard|bd|impasse|all[ée]e|chemin|place|route|quai|cité|cite|résidence|residence|lot(?:issement)?)"
STREET_EN = r"(?:street|st\.?|road|rd\.?|avenue|ave\.?|lane|ln\.?|close|drive|dr\.?|way|crescent|square|court|terrace|place|grove|gardens)"
ADDR_FR_RE = re.compile(rf"(?i)\b\d{{1,4}}\s?(?:bis|ter)?,?\s+{STREET_FR}\s+(?:(?:de|du|des|d'|la|le|l'|el|al)\s*)?[\w'’\-]+(?:\s+[\w'’\-]+){{0,4}}")
ADDR_FR2_RE = re.compile(rf"\b(?i:{STREET_FR})\s+(?:de\s|du\s|des\s|d'|la\s|le\s|l'|el\s|al\s|ibn\s|ben\s)?[A-ZÀ-Ý][\w'’\-]+(?:\s+[A-ZÀ-Ý][\w'’\-]+){{0,3}}(?:,?\s*(?:n[°o]\s*)?\d{{1,4}})?")
ADDR_EN_RE = re.compile(rf"\b\d{{1,4}}[a-zA-Z]?,?\s+(?:[A-Z][\w'’\-]+\s+){{1,4}}{STREET_EN}\b", re.I)
ADDR_AR_RE = re.compile(r"(?:نهج|شارع|زنقة|طريق|حي|عمارة|إقامة|اقامة)\s+(?:[؀-ۿ]+\s*){1,4}(?:عدد\s*)?\d{0,4}")
ADDR_AZ_RE = re.compile(r"(?i)\b(?:nahj|ne7j|nahj|charaa|zan9a|zanka)\s+(?:[a-z0-9'’\-]+\s*){1,4}")
NAME_CUE_RE = re.compile(
    r"(?:(?i:je m'appelle|je m’appelle|moi c'est|mon nom est|je suis|my name is|i am called|i'm|i am|this is|name's|esmi|ismi|ana esmi|ena esmi|"
    r"contactez|contacte[rz]?|appelez|appelle[rz]?|demandez|ask for|call|text)\s+)"
    r"([A-ZÀ-Ý][a-zß-ÿ'’\-]{1,30}(?:\s+[A-ZÀ-Ý][a-zß-ÿ'’\-]{1,30}){0,2})")
TITLE_RE = re.compile(r"\b(?:M\.|Mme\.?|Mlle\.?|Mr\.?|Mrs\.?|Ms\.?|Miss|Monsieur|Madame|Dr\.?|Si)\s+([A-ZÀ-Ý][\w'’\-]{1,30}(?:\s+[A-ZÀ-Ý][\w'’\-]{1,30}){0,2})")
NAME_AR_RE = re.compile(r"(?:اسمي|إسمي|انا اسمي|أنا اسمي|السيد|السيدة|الأستاذ|الاستاذ|مدام|سي)\s+([؀-ۿ]{2,20}(?:\s+[؀-ۿ]{2,20})?)")


def _luhn_ok(digits: str) -> bool:
    try:
        return luhn.is_valid(digits)
    except Exception:
        return False


def find_emails(t):
    return [Span(m.start(), m.end(), "EMAIL", m.group(), "pattern") for m in EMAIL_RE.finditer(t)]


def find_phones(t):
    out = []
    for region in ("TN", "FR", "GB"):
        # POSSIBLE, with at least 8 digits: the first run accepted 4- and 5-digit GB numbers (prices, years,
        # postcodes; reports/phase4/01-pii-first-run-no-ner.log); VALID instead rejected real-looking mobile
        # numbers outside the allocated ranges known to libphonenumber (second run, 02-...). A person's number
        # is masked even if its range is not allocated. Two years side by side ("2026 2027") are not a number.
        for m in phonenumbers.PhoneNumberMatcher(t, region, leniency=phonenumbers.Leniency.POSSIBLE):
            digits = re.sub(r"\D", "", m.raw_string)
            before, after = t[max(0, m.start - 2):m.start], t[m.end:m.end + 2]
            inside_longer = bool(re.search(r"\d[ .-]?$", before) or re.match(r"^[ .-]?\d", after))
            if len(digits) >= 8 and not inside_longer and not YEARS_RE.fullmatch(m.raw_string.strip()):
                out.append(Span(m.start, m.end, "PHONE", m.raw_string, f"phonenumbers:{region}"))
    for m in EIGHT_RE.finditer(t):                     # Tunisian numbers start with 2, 3, 4, 5, 7 or 9
        d = re.sub(r"\D", "", m.group())
        if d[0] in "234579" and not ID_CUE_RE.search(t[max(0, m.start() - 30):m.start()]) and not YEARS_RE.fullmatch(m.group()):
            out.append(Span(m.start(), m.end(), "PHONE", m.group(), "tn_8_digits"))
    return out


def find_cards(t):
    out = []
    for m in CARD_RE.finditer(t):
        d = re.sub(r"\D", "", m.group())
        if 13 <= len(d) <= 19 and _luhn_ok(d) and len(set(d)) > 1:
            out.append(Span(m.start(), m.end(), "CARD", m.group(), "luhn"))
    return out


def find_ibans(t):
    out = []
    for m in IBAN_RE.finditer(t):
        raw = m.group()
        # shrink from the right until it validates (the pattern may swallow a following word)
        s = raw
        while len(re.sub(r"\s", "", s)) >= 15:
            try:
                IBAN(re.sub(r"\s", "", s).upper())
                out.append(Span(m.start(), m.start() + len(s), "IBAN", s, "schwifty"))
                break
            except Exception:
                s = s[:-1].rstrip()
    return out


def find_ids(t):
    out = []
    for m in NIR_RE.finditer(t):
        d = re.sub(r"[ .]", "", m.group()).upper()
        try:
            if len(d) == 15 and fr_nir.is_valid(d):
                out.append(Span(m.start(), m.end(), "ID", m.group(), "fr_nir"))
            elif len(d) == 13:
                fr_nir.compact(d)
                out.append(Span(m.start(), m.end(), "ID", m.group(), "fr_nir_no_key", 0.8))
        except Exception:
            pass
    for m in NINO_RE.finditer(t):
        out.append(Span(m.start(), m.end(), "ID", m.group(), "uk_nino"))
    for m in EIGHT_RE.finditer(t):
        d = re.sub(r"\D", "", m.group())
        cue = ID_CUE_RE.search(t[max(0, m.start() - 40):m.start()])
        if cue or d[0] in "01":
            out.append(Span(m.start(), m.end(), "ID", m.group(), "tn_cin" + ("_cue" if cue else "")))
    return out


def find_addresses(t):
    out = []
    for rx, src in ((ADDR_FR_RE, "fr_street"), (ADDR_FR2_RE, "fr_street_name"), (ADDR_EN_RE, "en_street"),
                    (ADDR_AR_RE, "ar_street"), (ADDR_AZ_RE, "arabizi_street")):
        for m in rx.finditer(t):
            out.append(Span(m.start(), m.end(), "ADDRESS", m.group().rstrip(" ,"), src, 0.9))
    for m in UK_POSTCODE_RE.finditer(t):
        out.append(Span(m.start(), m.end(), "POSTCODE", m.group(), "uk_postcode"))
    return out


def find_names_by_cues(t):
    out = []
    for rx in (NAME_CUE_RE, TITLE_RE, NAME_AR_RE):
        for m in rx.finditer(t):
            out.append(Span(m.start(1), m.end(1), "NAME", m.group(1), "cue", 0.9))
    return out


class NER:
    """Token-classification model (transformers), loaded only when NER_MODEL points to a local directory."""

    def __init__(self, path: str):
        from transformers import pipeline
        self.pipe = pipeline("token-classification", model=path, tokenizer=path, aggregation_strategy="simple", device=-1)

    def names(self, t: str) -> list[Span]:
        out = []
        for e in self.pipe(t):
            if e.get("entity_group") in ("PER", "PERSON") and float(e.get("score", 0)) >= float(os.environ.get("NER_MIN_SCORE", "0.6")):
                out.append(Span(int(e["start"]), int(e["end"]), "NAME", t[int(e["start"]):int(e["end"])], "ner", float(e["score"])))
        return out


NER_ERROR: str | None = None


@lru_cache(maxsize=1)
def ner() -> NER | None:
    """NER_MODEL: a local directory written by fetch_models.py. Unset or missing: cue patterns only.
    A model that is present but fails to load is reported (NER_ERROR, the "ner_error" field of /v1/pii/mask
    and /v1/analyze) instead of stopping the service: language ID and the patterns keep working (F-057)."""
    global NER_ERROR
    path = os.environ.get("NER_MODEL", "")
    if path and os.path.isdir(path) and any(Path(path).iterdir()):
        try:
            return NER(path)
        except Exception as e:  # noqa: BLE001  (any load failure: missing package, bad files)
            NER_ERROR = f"{type(e).__name__}: {str(e)[:300]}"
            logging.getLogger("text").error("NER model at %s not loaded: %s", path, NER_ERROR)
    return None


def detect(text: str, use_ner: bool = True) -> list[Span]:
    spans = (find_emails(text) + find_ibans(text) + find_cards(text) + find_ids(text) + find_phones(text)
             + find_addresses(text) + find_names_by_cues(text))
    model = ner() if use_ner else None
    if model:
        spans += model.names(text)
    # overlaps: keep the higher-priority type, then the longer span
    spans.sort(key=lambda s: (-PRIORITY[s.type], -(s.end - s.start), s.start))
    kept: list[Span] = []
    for s in spans:
        if all(s.end <= k.start or s.start >= k.end for k in kept):
            kept.append(s)
    return sorted(kept, key=lambda s: s.start)


def mask(text: str, use_ner: bool = True) -> dict:
    spans = detect(text, use_ner)
    counters: dict[str, int] = {}
    seen: dict[tuple[str, str], str] = {}
    out, last, entities = [], 0, []
    for s in spans:
        key = (s.type, re.sub(r"\s", "", s.value).lower())
        if key not in seen:
            counters[s.type] = counters.get(s.type, 0) + 1
            seen[key] = f"[{s.type}_{counters[s.type]}]"
        ph = seen[key]
        out.append(text[last:s.start])
        out.append(ph)
        last = s.end
        entities.append({"type": s.type, "start": s.start, "end": s.end, "placeholder": ph, "source": s.source})
    out.append(text[last:])
    return {"masked_text": "".join(out), "entities": entities,
            "mapping": {ph: next(sp.value for sp in spans if (sp.type, re.sub(r"\s", "", sp.value).lower()) == k)
                        for k, ph in seen.items()},
            "counts": counters, "ner": bool(use_ner and ner()),
            **({"ner_error": NER_ERROR} if use_ner and NER_ERROR else {})}
