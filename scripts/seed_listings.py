"""Synthetic listings for phase 3 (spec 15.2 test data policy, D-060).

Every listing is flagged is_synthetic = true and source = 'synthetic'. Rents, deposits and
other values are drawn from ranges chosen to exercise the search filters (budgets, currencies,
weekly rents, distances); they are not market data and say nothing about real prices.
Places come from the gazetteer (app.places, coordinates from OpenStreetMap); the exact point
of a listing is a random point within 1.2 km of its place, and the database draws the public
(fuzzed) point.

    generate(places, n_by_jurisdiction, seed) -> list of listing dicts (pure, deterministic)
    upsert(conn, listings)                     -> writes them, removes synthetic listings not in the set

Used by scripts/p3.py seed-listings.
"""
from __future__ import annotations

import json
import math
import random
import uuid
from datetime import date, timedelta

NS = uuid.UUID("0d6a1f5e-6b7c-4e2a-9a51-3f0c2b8d7e11")
BASE_DATE = date(2026, 10, 1)            # fixed so the generated set does not depend on the run date
DEFAULT_COUNTS = {"TN": 72, "FR": 28, "GB": 20}
AMENITIES = ["wifi", "washing_machine", "air_conditioning", "heating", "balcony", "parking", "elevator", "dishwasher", "desk"]
LANGS = {"TN": [("fr", 50), ("ar", 25), ("en", 15), ("aeb-Latn", 10)], "FR": [("fr", 80), ("en", 20)], "GB": [("en", 100)]}

# Rent ranges in major units per month, by jurisdiction, kind and "capital" flag. Design choices
# for test data (see module docstring), not observations.
RANGES = {
    ("TN", "room", False): (250, 600), ("TN", "room", True): (300, 750), ("TN", "shared_flat", False): (600, 1200),
    ("TN", "shared_flat", True): (800, 1600), ("TN", "roommate_wanted", False): (200, 500), ("TN", "roommate_wanted", True): (250, 600),
    ("FR", "room", False): (380, 700), ("FR", "room", True): (650, 1100), ("FR", "shared_flat", False): (800, 1400),
    ("FR", "shared_flat", True): (1300, 2200), ("FR", "roommate_wanted", False): (350, 650), ("FR", "roommate_wanted", True): (600, 1000),
    ("GB", "room", False): (450, 800), ("GB", "room", True): (750, 1250), ("GB", "shared_flat", False): (900, 1600),
    ("GB", "shared_flat", True): (1600, 2600), ("GB", "roommate_wanted", False): (450, 750), ("GB", "roommate_wanted", True): (700, 1100),
}
CAPITALS = {"TN": {"Tunis", "Ariana", "Ben Arous", "Manouba", "La Marsa", "Carthage", "La Goulette", "Le Bardo"},
            "FR": {"Paris"}, "GB": {"London"}}
CURRENCY = {"TN": ("TND", 1000), "FR": ("EUR", 100), "GB": ("GBP", 100)}

TEXT = {
    "fr": {
        "title": {"room": ["Chambre meublée à {area}", "Chambre en colocation, {area}", "Grande chambre lumineuse à {area}"],
                  "shared_flat": ["Appartement à partager à {area}", "Colocation {bedrooms} chambres à {area}"],
                  "roommate_wanted": ["Cherche colocataire pour appartement à {area}"]},
        "intro": "Logement situé à {area}, {city}.", "near": "À quelques minutes de {campus}.",
        "flatmates": "{n} colocataire(s) actuellement.", "furnished": "Meublé.", "bills": "Charges comprises.",
        "no_bills": "Charges en plus.", "amen": "Équipements : {list}.", "smoke_no": "Non-fumeurs uniquement.",
        "smoke_yes": "Fumeurs acceptés.", "pets_yes": "Animaux acceptés.", "pets_no": "Pas d'animaux.",
        "quiet": "Ambiance calme, idéal pour étudiants et jeunes actifs.", "avail": "Disponible à partir du {date}.",
    },
    "en": {
        "title": {"room": ["Furnished room in {area}", "Double room in a flatshare, {area}", "Bright room near {area}"],
                  "shared_flat": ["{bedrooms}-bedroom flat to share in {area}", "Shared flat in {area}"],
                  "roommate_wanted": ["Flatmate wanted for our flat in {area}"]},
        "intro": "Home in {area}, {city}.", "near": "A few minutes from {campus}.",
        "flatmates": "{n} flatmate(s) living here.", "furnished": "Furnished.", "bills": "Bills included.",
        "no_bills": "Bills not included.", "amen": "Amenities: {list}.", "smoke_no": "Non-smokers only.",
        "smoke_yes": "Smokers welcome.", "pets_yes": "Pets allowed.", "pets_no": "No pets.",
        "quiet": "Quiet household, suits students and young professionals.", "avail": "Available from {date}.",
    },
    "ar": {
        "title": {"room": ["غرفة مفروشة للكراء في {area}", "غرفة في سكن مشترك، {area}"],
                  "shared_flat": ["شقة مشتركة للكراء في {area}"],
                  "roommate_wanted": ["نبحث عن شريك سكن في {area}"]},
        "intro": "السكن في {area}، {city}.", "near": "على بعد دقائق من {campus}.",
        "flatmates": "عدد الشركاء الحاليين: {n}.", "furnished": "مفروش.", "bills": "المصاريف مشمولة.",
        "no_bills": "المصاريف غير مشمولة.", "amen": "التجهيزات: {list}.", "smoke_no": "لغير المدخنين فقط.",
        "smoke_yes": "التدخين مسموح.", "pets_yes": "الحيوانات مقبولة.", "pets_no": "ممنوع الحيوانات.",
        "quiet": "جو هادئ.", "avail": "متوفر ابتداء من {date}.",
    },
    "aeb-Latn": {
        "title": {"room": ["bit lel kra fi {area}", "chambre fi colocation, {area}"],
                  "shared_flat": ["dar lel colocation fi {area}"],
                  "roommate_wanted": ["nlawej 3la colocataire fi {area}"]},
        "intro": "el dar fi {area}, {city}.", "near": "9rib barcha mel {campus}.",
        "flatmates": "fama {n} colocataire(s) taw.", "furnished": "mfarcha.", "bills": "el charges m7soubin.",
        "no_bills": "el charges mouch m7soubin.", "amen": "fama: {list}.", "smoke_no": "ma n7ebouch li ykayfou.",
        "smoke_yes": "tnajem tkayef.", "pets_yes": "l7ayawenet mrigla.", "pets_no": "ma fama 7ata 7ayawen.",
        "quiet": "dar hedia.", "avail": "disponible mel {date}.",
    },
}
AMEN_NAMES = {
    "fr": {"wifi": "wifi", "washing_machine": "machine à laver", "air_conditioning": "climatisation", "heating": "chauffage",
           "balcony": "balcon", "parking": "parking", "elevator": "ascenseur", "dishwasher": "lave-vaisselle", "desk": "bureau"},
    "en": {"wifi": "wifi", "washing_machine": "washing machine", "air_conditioning": "air conditioning", "heating": "heating",
           "balcony": "balcony", "parking": "parking", "elevator": "lift", "dishwasher": "dishwasher", "desk": "desk"},
    "ar": {"wifi": "انترنت", "washing_machine": "آلة غسيل", "air_conditioning": "مكيف", "heating": "تدفئة",
           "balcony": "شرفة", "parking": "مأوى سيارات", "elevator": "مصعد", "dishwasher": "آلة غسيل أواني", "desk": "مكتب"},
}
AMEN_NAMES["aeb-Latn"] = AMEN_NAMES["fr"]


def haversine_m(a_lat, a_lng, b_lat, b_lng):
    r = 6371000.0
    p1, p2 = math.radians(a_lat), math.radians(b_lat)
    dp, dl = p2 - p1, math.radians(b_lng - a_lng)
    h = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(h))


def offset(lat, lng, dist_m, bearing):
    """Point at dist_m and bearing (radians) from lat/lng (spherical earth)."""
    r = 6371000.0
    d = dist_m / r
    p1, l1 = math.radians(lat), math.radians(lng)
    p2 = math.asin(math.sin(p1) * math.cos(d) + math.cos(p1) * math.sin(d) * math.cos(bearing))
    l2 = l1 + math.atan2(math.sin(bearing) * math.sin(d) * math.cos(p1), math.cos(d) - math.sin(p1) * math.sin(p2))
    return math.degrees(p2), math.degrees(l2)


def pick_weighted(rng, pairs):
    total = sum(w for _, w in pairs)
    x = rng.uniform(0, total)
    for v, w in pairs:
        x -= w
        if x <= 0:
            return v
    return pairs[-1][0]


def area_name(place, lang):
    names = place.get("names") or {}
    if lang == "ar" and names.get("ar"):
        return names["ar"]
    return place["name"]


def generate(places: list[dict], counts: dict | None = None, seed: int = 20261003) -> list[dict]:
    """places: [{place_key, jurisdiction, kind, name, city, lat, lng, names: {lang: first name}}]"""
    counts = counts or DEFAULT_COUNTS
    rng = random.Random(seed)
    out = []
    for j, n in counts.items():
        homes = [p for p in places if p["jurisdiction"] == j and p["kind"] in ("neighbourhood", "district", "city")]
        campuses = [p for p in places if p["jurisdiction"] == j and p["kind"] == "campus"]
        if not homes:
            continue
        cur, mult = CURRENCY[j]
        for i in range(n):
            place = homes[rng.randrange(len(homes))]
            lat, lng = offset(place["lat"], place["lng"], 1200 * math.sqrt(rng.random()), rng.random() * 2 * math.pi)
            kind = pick_weighted(rng, [("room", 70), ("shared_flat", 20), ("roommate_wanted", 10)])
            capital = place["city"] in CAPITALS[j]
            lo, hi = RANGES[(j, kind, capital)]
            monthly = rng.randrange(lo, hi + 1, 10)
            period = "month"
            rent = monthly * mult
            if j == "GB" and rng.random() < 0.3:
                period = "week"
                rent = int(round(monthly * 12 / 52 / 5.0) * 5) * mult
            lang = pick_weighted(rng, LANGS[j])
            T = TEXT[lang]
            bedrooms = rng.randint(2, 4) if kind != "room" else rng.randint(1, 4)
            flatmates = rng.randint(0, 3)
            furnished = rng.random() < 0.8
            bills = rng.random() < 0.5
            amen = sorted(rng.sample(AMENITIES, rng.randint(2, 5)))
            smoking = pick_weighted(rng, [("no", 60), ("yes", 15), ("outside", 25)])
            pets = pick_weighted(rng, [("no", 65), ("yes", 35)])
            guests = pick_weighted(rng, [("ok", 60), ("limited", 40)])
            quiet = rng.random() < 0.5
            avail = BASE_DATE + timedelta(days=rng.randint(0, 90))
            stay = rng.choice([1, 3, 6, 9, 12])
            near = min(campuses, key=lambda c: haversine_m(lat, lng, c["lat"], c["lng"]), default=None)
            near = near if near and haversine_m(lat, lng, near["lat"], near["lng"]) < 3000 else None
            area = area_name(place, lang)
            city = place["city"]
            title = rng.choice(T["title"][kind]).format(area=area, bedrooms=bedrooms)
            parts = [T["intro"].format(area=area, city=city)]
            if near:
                parts.append(T["near"].format(campus=area_name(near, lang)))
            parts.append(T["flatmates"].format(n=flatmates))
            if furnished:
                parts.append(T["furnished"])
            parts.append(T["bills"] if bills else T["no_bills"])
            parts.append(T["amen"].format(list=", ".join(AMEN_NAMES[lang][a] for a in amen)))
            parts.append(T["smoke_no"] if smoking == "no" else T["smoke_yes"])
            parts.append(T["pets_yes"] if pets == "yes" else T["pets_no"])
            if quiet:
                parts.append(T["quiet"])
            parts.append(T["avail"].format(date=avail.isoformat()))
            out.append({
                "id": str(uuid.uuid5(NS, f"synthetic-listing-{j}-{i}")),
                "owner_index": rng.randrange(6),
                "jurisdiction_code": j, "kind": kind, "title": title, "description": " ".join(parts),
                "description_lang": lang, "rent_minor": rent, "currency": cur, "rent_period": period,
                "deposit_minor": rent if period == "month" else rent * 5,
                "bills_included": bills, "available_from": avail.isoformat(), "min_stay_months": stay,
                "bedrooms": bedrooms, "furnished": furnished, "current_flatmates": flatmates, "amenities": amen,
                "house_rules": {"smoking": smoking, "pets": pets, "guests": guests, "quiet_hours": "yes" if quiet else "no"},
                "lat": round(lat, 6), "lng": round(lng, 6), "country_code": j, "city": city,
                "neighbourhood": place["name"] if place["kind"] in ("neighbourhood", "district") else None,
                "place_key": place["place_key"], "near_campus": near["place_key"] if near else None,
                "published_at_days_ago": rng.randint(0, 60),
            })
    return out


def owners():
    return [{"id": str(uuid.uuid5(NS, f"synthetic-owner-{i}")), "external_auth_id": f"synthetic-owner-{i}",
             "display_name": f"Synthetic owner {i}"} for i in range(6)]


def upsert(conn, listings: list[dict]) -> dict:
    ow = owners()
    for o in ow:
        conn.execute("""insert into app.users (id, external_auth_id, display_name, role) values (%s, %s, %s, 'owner')
                        on conflict (id) do update set display_name = excluded.display_name""",
                     (o["id"], o["external_auth_id"], o["display_name"]))
    changed = 0
    for x in listings:
        row = conn.execute("select title, description from app.listings where id = %s", (x["id"],)).fetchone()
        conn.execute(
            """insert into app.listings (id, owner_id, jurisdiction_code, kind, source, is_synthetic, status, title, description,
                 description_lang, rent_minor, currency, rent_period, deposit_minor, bills_included, available_from,
                 min_stay_months, bedrooms, furnished, current_flatmates, amenities, house_rules, location, country_code,
                 city, neighbourhood, published_at, extraction)
               values (%s, %s, %s, %s, 'synthetic', true, 'published', %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s,
                 %s, %s::jsonb, st_setsrid(st_makepoint(%s, %s), 4326)::geography, %s, %s, %s,
                 now() - make_interval(days => %s), %s::jsonb)
               on conflict (id) do update set owner_id = excluded.owner_id, kind = excluded.kind, title = excluded.title,
                 description = excluded.description, description_lang = excluded.description_lang,
                 rent_minor = excluded.rent_minor, currency = excluded.currency, rent_period = excluded.rent_period,
                 deposit_minor = excluded.deposit_minor, bills_included = excluded.bills_included,
                 available_from = excluded.available_from, min_stay_months = excluded.min_stay_months,
                 bedrooms = excluded.bedrooms, furnished = excluded.furnished, current_flatmates = excluded.current_flatmates,
                 amenities = excluded.amenities, house_rules = excluded.house_rules, location = excluded.location,
                 country_code = excluded.country_code, city = excluded.city, neighbourhood = excluded.neighbourhood,
                 status = 'published', extraction = excluded.extraction""",
            (x["id"], ow[x["owner_index"]]["id"], x["jurisdiction_code"], x["kind"], x["title"], x["description"],
             x["description_lang"], x["rent_minor"], x["currency"], x["rent_period"], x["deposit_minor"], x["bills_included"],
             x["available_from"], x["min_stay_months"], x["bedrooms"], x["furnished"], x["current_flatmates"], x["amenities"],
             json.dumps(x["house_rules"]), x["lng"], x["lat"], x["country_code"], x["city"], x["neighbourhood"],
             x["published_at_days_ago"], json.dumps({"synthetic": {"place_key": x["place_key"], "near_campus": x["near_campus"]}})))
        if not row or row[0] != x["title"] or row[1] != x["description"]:
            conn.execute("update app.listings set embedding = null, embedding_model = null where id = %s", (x["id"],))
            changed += 1
    ids = [x["id"] for x in listings]
    # only listings this generator made (extraction->'synthetic'), in the jurisdictions it covers
    removed = conn.execute("""delete from app.listings where source = 'synthetic' and extraction ? 'synthetic'
                              and jurisdiction_code = any(%s) and not (id = any(%s::uuid[])) returning id""",
                           (sorted({x["jurisdiction_code"] for x in listings}), ids)).fetchall()
    return {"listings": len(listings), "new_or_changed_text": changed, "removed": len(removed)}
