"""Synthetic listings generator (scripts/seed_listings.py, D-060)."""
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts"))
import seed_listings as sl  # noqa: E402

PLACES = [  # test coordinates
    {"place_key": "tn-a", "jurisdiction": "TN", "kind": "neighbourhood", "name": "A", "city": "Tunis", "lat": 36.8, "lng": 10.18, "names": {"ar": "أ"}},
    {"place_key": "tn-b", "jurisdiction": "TN", "kind": "city", "name": "B", "city": "Sfax", "lat": 34.74, "lng": 10.76, "names": {}},
    {"place_key": "tn-c", "jurisdiction": "TN", "kind": "campus", "name": "Campus C", "city": "Tunis", "lat": 36.805, "lng": 10.18, "names": {}},
    {"place_key": "fr-a", "jurisdiction": "FR", "kind": "district", "name": "Paris 5e", "city": "Paris", "lat": 48.84, "lng": 2.35, "names": {}},
    {"place_key": "gb-a", "jurisdiction": "GB", "kind": "neighbourhood", "name": "Camden", "city": "London", "lat": 51.54, "lng": -0.14, "names": {}},
]


def test_deterministic_and_sized():
    a, b = sl.generate(PLACES), sl.generate(PLACES)
    assert a == b
    assert len(a) == sum(sl.DEFAULT_COUNTS.values())
    assert len({x["id"] for x in a}) == len(a)


def test_money_and_places():
    for x in sl.generate(PLACES):
        cur, mult = sl.CURRENCY[x["jurisdiction_code"]]
        assert x["currency"] == cur and x["rent_minor"] % mult == 0
        place = next(p for p in PLACES if p["place_key"] == x["place_key"])
        assert place["kind"] != "campus"
        assert sl.haversine_m(x["lat"], x["lng"], place["lat"], place["lng"]) <= 1201
        if x["rent_period"] == "week":
            assert x["jurisdiction_code"] == "GB"
        else:
            lo, hi = sl.RANGES[(x["jurisdiction_code"], x["kind"], place["city"] in sl.CAPITALS[x["jurisdiction_code"]])]
            assert lo * mult <= x["rent_minor"] <= hi * mult


def test_texts_follow_the_language():
    xs = sl.generate(PLACES)
    assert {x["description_lang"] for x in xs if x["jurisdiction_code"] == "GB"} == {"en"}
    ar = [x for x in xs if x["description_lang"] == "ar"]
    assert ar and all("أ" in x["title"] or "B" in x["title"] for x in ar)        # Arabic name used when known
    near = [x for x in xs if x["near_campus"]]
    assert near and all("Campus C" in x["description"] or x["description_lang"] == "ar" for x in near)
