"""Language and script identification (spec 9.7: runs before P1; Text service, spec 5.1).

Labels follow the P1 labelling guide (eval/datasets/guides/p1_router.md): fr, en, de, es, it, ar (Modern Standard
Arabic), aeb (Tunisian Arabic, in Arabic script or in Latin letters with digits, "arabizi"), mixed (two languages
each carrying whole clauses), other. Script: latin, arabic, mixed (both scripts, each more than one word), other.

How (D-074):
1. Script from the letters of each word.
2. Latin script: a Tunisian-arabizi detector (digits used as letters inside words, and a short list of frequent
   Tunisian words written in Latin letters). No published model labels arabizi (docs/research/PHASE4_COMPONENTS.md).
3. Otherwise a statistical backend: GlotLID v3 (fastText, labels aeb_Arab, arb_Arab, fra_Latn...) when its model
   file is present, else lingua (fr, en, de, es, it, ar only; it cannot tell Tunisian from MSA, so Arabic script
   then falls back to a Tunisian-marker word list).
4. mixed: clauses are labelled one by one; two languages each covering at least 30% of the words make 'mixed'.
Which backend is better is measured on the P1 golden set (scripts/p4.py langid-eval), not assumed.
"""
from __future__ import annotations

import os
import re
import unicodedata
from functools import lru_cache

ARABIC_RE = re.compile(r"[؀-ۿݐ-ݿࢠ-ࣿﭐ-﷿ﹰ-﻿]")
LATIN_RE = re.compile(r"[A-Za-zÀ-ɏ]")
WORD_RE = re.compile(r"[\w'’؀-ۿ]+", re.UNICODE)
CLAUSE_RE = re.compile(r"[.!?;:\n،؛؟]+|,\s+|\s+-\s+")

# Arabizi: digits standing for Arabic letters inside a word (3 = ع, 7 = ح, 9 = ق, 5 = خ, 2 = ء), e.g. n7eb, 3andi.
ARABIZI_DIGIT_RE = re.compile(r"(?i)^(?=.*[a-z])[a-z]*[235789][a-z]+[a-z0-9]*$|^[235789][a-z]{2,}$")
# Frequent Tunisian words in Latin letters (lower case). Kept short and checked against the golden set's
# non-Tunisian messages (no French or English word in the list collides with them; tests/test_langid.py).
TN_LATIN = set("""
n7eb nheb nhab t7eb theb ya7eb bit biit dar mel m3a ma3a mte3i mta3i mta3 mte3 bech bch famma fama fema tawa taw
barcha barsha yesser yaser chnowa chnoua chneya chniya kifech kifach 9adech kadech gaddech 9adeh 3andi andi 3ana
nlawej nlawjou lawej tlawej lawajli 5edma nekhdem ne5dem nekhdmou ye5dem 9rib qrib b3id ba3id ya5i ye5i yezzi
behi bahi mouch mech mich lezem lezm brabi barra 3la 3al 3ali chhar chhar jey jeya alf malyoun lil nhar ghodwa
lyoum toul w9t wa9t sou2el soal mochkla mouchkla bnet wled sbe7 la3ben slm aslema 3aslema chkoun kol koll
wa7da wa7ed zouz thletha arba3 khamsa sitta sab3a tmanya tes3a 3ochra nos se3a rob3 kra el fil fel men
""".split())
# Words that are also French/English/Spanish/Italian and must not count as Tunisian on their own.
TN_AMBIGUOUS = {"el", "fil", "fel", "men", "dar", "bit", "nos", "kra", "lil", "kol", "toul"}
TN_ARABIC = set("""
نحب نحبو برشا باش متاع متاعي توا فما فمة كان نلوج نلوجو ياسر بالله شنوة شنية علاش كيفاش قداش وقتاش موش مش
باهي حاجة ديما زادة برك نخدم نقرا الكرا كرا بش هاذي هاذا هذاكا ياخي نجم نجموا نسأل حكاية حد عندي عندك
""".split())
MSA_ARABIC = set("""
أبحث ابحث الذي التي هل يحق ميزانيتي شهريا شهريًا حوالي ابتداء ابتداءً اعتبارا إيجار الإيجار المالك أريد
لدي استفسار بخصوص يمكن يجب عن من إلى في قرب قريبة
""".split())

GLOTLID_MAP = {"fra_Latn": "fr", "eng_Latn": "en", "deu_Latn": "de", "spa_Latn": "es", "ita_Latn": "it",
               "arb_Arab": "ar", "aeb_Arab": "aeb", "ary_Arab": "ar", "arz_Arab": "ar", "arq_Arab": "aeb",
               "apc_Arab": "ar", "ajp_Arab": "ar", "acm_Arab": "ar", "ars_Arab": "ar", "arb_Latn": "aeb"}


def _norm(w: str) -> str:
    w = unicodedata.normalize("NFKC", w).lower().strip("'’")
    return w


def words(text: str) -> list[str]:
    return [w for w in WORD_RE.findall(text) if any(c.isalpha() for c in w) or ARABIZI_DIGIT_RE.match(w)]


def script_of(text: str) -> tuple[str, int, int]:
    ws = words(text)
    ar = sum(1 for w in ws if ARABIC_RE.search(w))
    la = sum(1 for w in ws if LATIN_RE.search(w) and not ARABIC_RE.search(w))
    if ar >= 2 and la >= 2:
        return "mixed", ar, la
    if ar > la:
        return "arabic", ar, la
    if la > 0:
        return "latin", ar, la
    return ("arabic" if ar else "other"), ar, la


def arabizi_score(text: str) -> float:
    ws = [_norm(w) for w in words(text) if not ARABIC_RE.search(w)]
    if not ws:
        return 0.0
    hits = 0
    for w in ws:
        if ARABIZI_DIGIT_RE.match(w):
            hits += 1
        elif w in TN_LATIN and w not in TN_AMBIGUOUS:
            hits += 1
        elif w in TN_LATIN:
            hits += 0.3
    return hits / len(ws)


def tunisian_arabic_score(text: str) -> tuple[float, float]:
    ws = [_norm(w).lstrip("و") if len(w) > 3 else _norm(w) for w in words(text) if ARABIC_RE.search(w)]
    if not ws:
        return 0.0, 0.0
    tn = sum(1 for w in ws if w in TN_ARABIC or w.lstrip("ال") in TN_ARABIC)
    msa = sum(1 for w in ws if w in MSA_ARABIC)
    return tn / len(ws), msa / len(ws)


class Backend:
    name = "none"

    def predict(self, text: str) -> list[tuple[str, float]]:
        return []


class GlotLID(Backend):
    name = "glotlid-v3"

    def __init__(self, path: str):
        import fasttext
        fasttext.FastText.eprint = lambda *a, **k: None
        self.model = fasttext.load_model(path)

    def predict(self, text: str) -> list[tuple[str, float]]:
        # The low-level call returns (probability, label) pairs; it avoids the NumPy 2 incompatibility of
        # fasttext's Python wrapper (FastText.predict uses np.array(..., copy=False)).
        t = " ".join(text.split())
        pairs = self.model.f.predict(t + "\n", 5, 0.0, "strict")
        return [(label.replace("__label__", ""), float(p)) for p, label in pairs]


class Lingua(Backend):
    name = "lingua"

    def __init__(self):
        from lingua import Language, LanguageDetectorBuilder
        self.L = Language
        langs = [Language.FRENCH, Language.ENGLISH, Language.GERMAN, Language.SPANISH, Language.ITALIAN, Language.ARABIC]
        self.det = LanguageDetectorBuilder.from_languages(*langs).with_preloaded_language_models().build()
        self.map = {Language.FRENCH: "fra_Latn", Language.ENGLISH: "eng_Latn", Language.GERMAN: "deu_Latn",
                    Language.SPANISH: "spa_Latn", Language.ITALIAN: "ita_Latn", Language.ARABIC: "arb_Arab"}

    def predict(self, text: str) -> list[tuple[str, float]]:
        vals = self.det.compute_language_confidence_values(text)
        return [(self.map[v.language], float(v.value)) for v in vals[:5]]


@lru_cache(maxsize=1)
def default_backend() -> Backend:
    choice = os.environ.get("LANGID_BACKEND", "auto")
    path = os.environ.get("GLOTLID_MODEL", "/models/glotlid/model_v3.bin")
    if choice in ("auto", "glotlid") and os.path.exists(path):
        return GlotLID(path)
    if choice == "glotlid":
        raise RuntimeError(f"GlotLID model not found at {path}")
    try:
        return Lingua()
    except Exception:
        return Backend()


def _label_one(text: str, backend: Backend) -> tuple[str, float, str]:
    """Language of one clause (no 'mixed'). Returns (label, confidence, method)."""
    sc, ar, la = script_of(text)
    if sc == "latin":
        az = arabizi_score(text)
        if az >= 0.2:
            return "aeb", min(0.99, 0.5 + az), "arabizi_rules"
    preds = backend.predict(text) if words(text) else []
    if preds:
        code, p = preds[0]
        lab = GLOTLID_MAP.get(code)
        if sc == "arabic" or (lab in ("ar", "aeb")):
            tn, msa = tunisian_arabic_score(text)
            if backend.name == "lingua" or lab not in ("ar", "aeb"):
                lab = "aeb" if tn > msa and tn > 0 else "ar"
                return lab, max(0.5, p), f"{backend.name}+tn_words"
            return lab, p, backend.name
        if lab:
            return lab, p, backend.name
        return "other", p, backend.name
    if sc == "arabic":
        tn, msa = tunisian_arabic_score(text)
        return ("aeb" if tn > msa else "ar"), 0.5, "tn_words"
    return "other", 0.0, "none"


def identify(text: str, backend: Backend | None = None) -> dict:
    backend = backend or default_backend()
    text = text or ""
    sc, ar, la = script_of(text)
    whole, conf, method = _label_one(text, backend)
    # clause-level check for code-switching (P1 guide: two languages each carrying whole clauses)
    clauses = [c.strip() for c in CLAUSE_RE.split(text) if len(words(c)) >= 3]
    share: dict[str, int] = {}
    for c in clauses:
        lab, _, _ = _label_one(c, backend)
        share[lab] = share.get(lab, 0) + len(words(c))
    total = sum(share.values())
    big = [k for k, n in share.items() if total and n / total >= 0.3 and k != "other"]
    if len(big) >= 2:
        return {"language": "mixed", "script": sc, "confidence": round(conf, 3), "method": method + "+clauses",
                "parts": {k: round(n / total, 2) for k, n in share.items()}}
    if sc == "mixed" and whole == "aeb" and ar >= 2 and la >= 2 and arabizi_score(text) < 0.2:
        # Arabic-script Tunisian with whole French/English stretches
        return {"language": "mixed", "script": sc, "confidence": round(conf, 3), "method": method + "+scripts",
                "parts": {"arabic_words": ar, "latin_words": la}}
    return {"language": whole, "script": sc, "confidence": round(conf, 3), "method": method}
