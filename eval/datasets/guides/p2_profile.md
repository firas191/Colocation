# Labelling guide: P2 profile extractor (golden set `p2_profile`)

One item is one search request from a seeker, with the structured profile the extractor
(prompt P2, spec 9.4) should produce. Labels hold only what the request states or directly
implies. Anything not stated is `null` (or empty). Never fill a value from what is "typical".

## Item format (one JSON object per line)

```json
{"id": "p2-001",
 "message": "Je cherche une chambre près d'ESPRIT, max 450 DT par mois, à partir de novembre, non fumeur",
 "context": {"jurisdiction": "TN", "today": "2026-10-01"},
 "gold": {
   "profile": {"jurisdiction_code": "TN", "budget_min_minor": null, "budget_max_minor": 450000, "currency": "TND",
               "budget_period": "month", "anchor_label": "ESPRIT", "max_commute_min": null,
               "move_in_from": "2026-11-01", "min_stay_months": null,
               "declared_preferences": {"smoking": "no"}, "languages": []},
   "must_not_map": []},
 "tags": ["fr", "tn"],
 "note": "450 DT = 450000 millimes"}
```

- `context.jurisdiction`: the jurisdiction of the person's account; `context.today`: the date the
  request is made (relative dates are resolved against it). Both are given to the extractor.
- `gold.profile`: every field of the P2 output except `unparsed` and `field_confidence`.
- `gold.must_not_map`: words of the request that express a preference that is not allowed (see
  "Preferences") and so must not appear in `declared_preferences`; they should end up in `unparsed`.
- `tags`: language group (`fr`, `en`, `ar`, `aeb_arabic`, `aeb_latin`, `mixed`), jurisdiction (`tn`,
  `fr_j`, `gb`), and any of `unit_trap`, `no_budget`, `relative_date`, `protected_pref`, `range`,
  `weekly`, `foreign_currency`, `commute`, `injection`.

## Fields

**jurisdiction_code**: `TN`, `FR` or `GB` when the request names a place, institution or currency of
that country, or `null` when it names none. The account's jurisdiction alone does not fill it. A
request from a TN account for a room in Paris is `FR`.

**budget_min_minor / budget_max_minor**: integers in minor units of `currency`: TND has 3 decimals
(1 dinar = 1000 millimes), EUR and GBP have 2 (1 euro = 100 cents). So 450 DT -> 450000; 650 EUR ->
65000; 1 200 GBP -> 120000.
- "max 450", "jusqu'à 450", "450 maximum", "budget 450", "around 450", "pas plus de 450" -> max only.
- "between 300 and 400", "300-400", "de 300 à 400" -> min 300, max 400 (in minor units).
- "at least 300", "à partir de 300" (about price) -> min only.
- Unit traps, labelled with the amount the person means:
  - Tunisian usage counts in millimes: "450 alf", "450 mille", "450 000" next to dinars, all mean
    450 dinars -> 450000. "malyoun" / "un million" means 1000 dinars -> 1000000; "malyoun w nos" means
    1500 dinars -> 1500000.
  - Thousands separators: "1.500 DT" and "1 500 DT" are 1500 dinars, not 1.5; "1,200 £" is 1200 pounds.
  - "k" means thousand: "1.2k €" -> 1200 euros -> 120000.
  - "500€ CC" / "charges comprises" and "HC" / "hors charges" do not change the amount; record the
    amount as stated.
- No amount stated -> both `null` (tag `no_budget`). Words like "pas cher", "cheap", "raisonnable"
  are not amounts.
- A total for several months ("3000 DT pour 3 mois") is not a monthly budget: leave `null` and the
  text goes to `unparsed`.

**currency**: ISO code of the stated amount. When an amount is stated with no currency, use the
currency of the place the request is about (jurisdiction_code), or else of the account's jurisdiction.
When no amount is stated, `null`. A request in euros for a room in Tunisia keeps `EUR` (tag
`foreign_currency`); conversion happens later.

**budget_period**: `month` or `week` when an amount is stated: "per week", "pw", "/semaine", "par
semaine" -> `week`; "per month", "pcm", "/mois", "par mois", or nothing said -> `month`. `null` when
no amount is stated.

**anchor_label**: the place the person wants to live near or in, as they name it, without
prepositions or travel phrases: "près d'ESPRIT" -> "ESPRIT"; "à 15 min de La Défense" -> "La Défense";
"in Camden" -> "Camden"; "fi lmarsa" -> "lmarsa". Spelling is kept as written. If several places are
named, the most specific one the person wants to be near (a campus or workplace over a city). `null`
when no place is named.

**max_commute_min**: minutes when a travel time is stated ("15 min walk", "max 30 minutes en
métro", "nos se3a" = 30). Hours become minutes. `null` otherwise. Distances in km or metres are not
minutes: `null`, the text goes to `unparsed`.

**move_in_from**: date (YYYY-MM-DD) from which the person wants to move in, resolved against
`context.today`:
- a date -> that date; a month only ("en novembre", "from January") -> the 1st of that month, in the
  next occurrence of that month after today (in the current month if it is today's month);
- "début [month]" -> the 1st; "mi-[month]" / "mid-[month]" -> the 15th; "fin [month]" / "end of
  [month]" -> the last day of the month;
- "dès que possible", "asap", "immediately", "now" -> `context.today`;
- "next month" / "le mois prochain" / "chhar jey" -> the 1st of the next month;
- "next week" -> today + 7 days;
- vague or calendar-dependent ("après le ramadan", "à la rentrée", "this summer") -> `null`, the text
  goes to `unparsed`.

**min_stay_months**: the shortest stay they commit to, in months: "for 6 months" -> 6; "for the
academic year" / "année universitaire" -> 9; "one year" -> 12; "at least 3 months" -> 3; "2 weeks" ->
`null` (not a whole number of months; text to `unparsed`). `null` when not stated.

**declared_preferences**: only these keys, only when the person states them about the home they
want or about themselves:
- `smoking`: `no` (non-smoker, wants a non-smoking home) or `yes` (smokes, wants smoking allowed);
- `pets`: `yes` (has a pet or wants pets allowed) or `no` (wants no pets);
- `quiet_hours`: `yes` (wants a quiet home, quiet in the evening, students who work);
  `no` (likes parties, a lively home);
- `guests`: `yes` (wants to be able to have visitors / partner over) or `no` (wants few or no guests);
- `schedule`: `early` (early riser, day job), `late` (night shifts, late hours), `irregular`;
- `cleanliness`: `high` (very tidy), `medium`, `relaxed`.
Omit a key that is not stated (do not write "any").

**Preferences that are not allowed (tag `protected_pref`)**: gender of the flatmates or the
person's gender as a requirement ("filles uniquement", "girls only", "pour un homme"), religion,
ethnicity, nationality, origin, age, marital or family status, sexual orientation, health or
disability. They are never put in `declared_preferences`. List the words that express them in
`must_not_map` (e.g. `["filles uniquement"]`). This applies in every jurisdiction in this version,
because no pack lists them as allowed (spec 4.4: default is deny).

**languages**: languages the person says they speak or want to speak at home, as codes `ar`, `aeb`
(Tunisian), `fr`, `en`, `de`, `es`, `it`. The language the request is written in is not a declared
language. Empty list when none is stated.

## What is not labelled

`unparsed` and `field_confidence` are not labelled. Unparsed text is scored only through
`must_not_map` (those words must not become preferences). Furnished, room type, bills, floor, parking,
and other listing features are not profile fields in this version; they are allowed in `unparsed`.

## Coverage of the set (version 1)

At least 100 requests; at least 20 tagged `unit_trap`, 15 `no_budget`, 10 `protected_pref`,
10 `relative_date`; TN, FR and GB requests; French, English, Arabic script, Tunisian in Arabic script
and in Latin letters, and code-switched messages. Messages are synthetic: written for this set.
