# Evaluation datasets

`manifest.json` lists the datasets that `scripts/kb.py seed` loads into `eval.datasets` and
`eval.queries`. A dataset with evaluation runs cannot change silently: change the version, or
pass `--force`.

## tn_retrieval v1 (`tn_retrieval_v1.jsonl`, written by `build_tn_retrieval_v1.py`)

48 questions about renting and flatsharing in Tunisia, written by reading the texts exported
after the TN ingestion of T-27, with the extraction changes of T-28 and T-30 applied, before any retrieval
was run on them.

| Group | Queries | Notes |
|---|---|---|
| French | 25 (tn-01 to tn-25) | direct lookups, article questions, practical questions |
| English | 5 (tn-26 to tn-30) | `cross_lingual`: the corpus has no English text |
| Arabic script | 6 (tn-31 to tn-36) | standard Arabic and Tunisian; tn-36 is `cross_lingual` |
| Transliterated Tunisian | 4 (tn-37 to tn-40) | `arabizi` |
| Code-switched | 4 (tn-41 to tn-44) | Tunisian and French, `code_switch` |
| Out of scope | 4 (tn-45 to tn-48) | `abstain`, no gold; not scored for retrieval |

Ten questions are tagged `contradiction`: the corpus holds sources that disagree (for example,
the Code of Obligations and Contracts art. 772 allows subletting unless forbidden, law 76-35
art. 32 forbids it without consent for the old premises it covers, and a blog says consent is
always needed). Their gold lists every side.

Rules for the gold:

- A gold span is a pair of quotes (`start`, `end`) in one document; `eval.resolve_gold` turns it
  into character offsets of the current version. The start quote must occur once in the
  document. `kb.py check-gold` fails if any span is not found or is ambiguous, and the
  evaluation refuses to run in that case.
- Relevance does not depend on chunking: a retrieved chunk counts for a gold span when they
  overlap by at least half of the shorter of the two (D-039).
- Language: the gold is the supporting text in the language of the question when the corpus
  has it (Arabic questions about the Code: the Arabic text). Otherwise the French text, and the
  question is tagged `cross_lingual`. Transliterated and code-switched questions list both the
  Arabic and the French text when both exist.
- `gold.note` says what the answer is, for a human reader; it is not used in scoring.
- Blogs and press pages are included as gold when they state the point, since retrieval
  should find them; whether an answer may rely on them is decided by source reliability at
  answer time (phase 6), not here.

## tn_retrieval v2 (`tn_retrieval_v2.jsonl`, written by `build_tn_retrieval_v2.py`)

Same 48 questions; the gold adds every passage that answers the question among those the first
evaluation retrieved (D-052). Built after reading the v1 run showed that relevant secondary passages were
missing from the gold (`eval/reports/tried.md`).

- Pool: the top 10 of each of the 12 runs of job `92e8c6cd`, merged where passages overlap: 1,060
  regions for the 44 scored questions (`pool_v2/pool_regions.json`, ranges only).
- Judging: each region judged against written rules (`pool_v2/judgments.json`, with grade and a
  one-sentence reason): relevant when it states the rule, right, condition, amount or procedure asked
  about, or a necessary part of it; any language; every side of a contradiction. Not relevant when only
  on the topic, when it states French law for a Tunisian question (scam advice excepted), or when it is
  the rule of another regime (commercial leases, rural leases, professional premises). The judging was
  done by eight model-based annotators working in parallel, each on a share of the questions; I then
  read every proposed new passage (135; 4 rejected, `pool_v2/review.json`) and 25 randomly drawn "not
  relevant" judgments (agreed with 24; the other was borderline). No human has checked the judgments.
- Need groups: questions that ask the same thing in other words or languages share their relevant
  passages (`review.json`, 12 groups), so the answer to a question does not depend on which of its
  paraphrases happened to retrieve it.
- Overlapping passages of one document are merged, so a passage is credited once.
- Result: 304 gold spans (89 in v1): 29 for each scam question and 13 for each registration question,
  which many sources answer, and 1 or 2 for the narrow article questions. With that many spans,
  recall@k is low by construction for the broad questions, so recall is not comparable between v1 and v2;
  Hit@k and MRR are.
- Known bias of pooling: passages that none of the 12 runs retrieved are not judged and count as not
  relevant, and a future configuration that finds new relevant passages is under-scored until they are
  judged.

## p1_router v1 (`p1_router_v1.jsonl`) and p2_profile v1 (`p2_profile_v1.jsonl`)

Golden sets for the router (P1) and the profile extractor (P2), spec 9.5. Labelling guides:
`guides/p1_router.md` and `guides/p2_profile.md`; every label follows them. Both sets are synthetic
(written for the set, no real user messages) and were written and labelled by a model-based
annotator (D-055).

| Set | Items | Composition |
|---|---|---|
| P1 | 160 | language groups fr 34, en 24, ar 14, Tunisian in Arabic script 16, Tunisian arabizi 22, code-switched 22, de 10, es 9, it 9; intents search 45, post 25, legal 30, document 15, report 18, smalltalk/unsupported 27; tags injection 18, mixed_intent 12, ambiguous 10 (needs_clarification), digits_trap 10 |
| P2 | 110 | account jurisdiction TN 55, FR 30, GB 25; tags unit_trap 52, relative_date 49, protected_pref 22, no_budget 21, commute 19, range 10, weekly 6, foreign_currency 6, injection 5; five "today" dates |

Format: one object per line with `id`, `message`, `context` (`user_jurisdiction` for P1;
`jurisdiction` and `today` for P2), `gold`, `tags`, `note`. `scripts/kb.py seed` stores the message
as `eval.queries.query` and `{"labels": gold, "context": context}` as `eval.queries.gold`.

Re-label (spec 9.5): `relabel/<set>_blind.jsonl` holds a random 20% (seed 20261002) with id, message
and context only; a second annotator labelled them from the guide alone (`relabel/<set>_relabel.jsonl`);
`python eval/datasets/agreement.py <set>` writes `relabel/<set>_agreement.json`:

| Set | Re-labelled | Items equal on every field | Per field |
|---|---|---|---|
| P1 | 32 of 160 | 31 | intent 32/32 (Cohen's kappa 1.000), acceptable intents 32/32, language 31/32, script 32/32, jurisdiction hint 32/32, needs_clarification 32/32 |
| P2 | 22 of 110 | 21 | every field 22/22 except anchor_label 21/22 ("Nation" vs "métro Nation") |

Both annotators are models working from the same guide: the agreement shows the guide leaves little
room for interpretation to such an annotator; it does not show human agreement. Tunisian Derja and
arabizi items have not been checked by a native speaker (spec 9.7).

## p3_listing v1 (`p3_listing_v1.jsonl`)

Golden set for the listing extractor (P3), spec 9.5: 100 synthetic listings written for the set and
labelled by a model-based annotator from `guides/p3_listing.md` (D-055). Amounts are in the main unit
of the currency (D-066); code converts them.

| Group | Count |
|---|---|
| Jurisdiction | TN 50, FR 25, GB 25 |
| Language | fr 30, en 25, ar 10, Tunisian in Arabic script 10, Tunisian arabizi 15, code-switched 10 (20 in Arabic script) |
| Kind | room 60, shared_flat 22, roommate_wanted 18 |
| Tags | unit_trap 34, relative_date 46, bills 60, per_person (rent-scope traps) 24, deposit_months 15, no_price 15, weekly 8, injection 6, discriminatory 6 |

Every item has `today` 2026-10-01. The spec asks for 20 items with scale and unit traps and 20 in
non-Latin scripts; the set has 34 and 20.

Re-label: 20 items drawn with seed 20261004 (`relabel/p3_listing_v1_blind.jsonl`), labelled blind by a
second model-based annotator. Agreement before adjudication (`relabel/p3_listing_v1_agreement.json`):
15 of 20 items equal on every field; kind 19/20 (Cohen's kappa 0.924), furnished 17/20, amenities 18/20,
every other field 20/20. The disagreements were three points the guide did not settle:

- Tunisian `fergha` / `فارغة` ("vacant" or "empty"): the first labels read it as unfurnished, the
  re-label left it null.
- "internet" and "fibre" without the word wifi: the first labels left wifi out, the re-label put it in.
- An owner letting a room in the house they live in: `room` or `roommate_wanted`.

I settled them in the guide (null; wifi; room) and applied the rule to every item it covers, including
two outside the sample (p3-021, p3-069): 7 label changes, listed in
`relabel/p3_listing_v1_adjudication.json`. The agreement file holds the numbers before these
changes; running `agreement.py p3_listing_v1` again would compare against the adjudicated labels.

## p7_photos v1 (`p7_photos_v1.jsonl`)

50 photos for P7 (spec 9.5: 50 labelled room photos), chosen on 2026-10-05 from 125 candidates that
`scripts/photos.py fetch` found on Wikimedia Commons with 14 searches (D-069). Left out: museum interiors (palace ceilings,
statues, period rooms), near repeats of a kept photo, and enough building fronts and floor plans to keep rooms the large
majority. Groups: bedroom 13, living 10, other 9, not_a_room 7, bathroom 6, kitchen 5. Tags: text 9, people 5, dark 5,
poor_condition 5, clutter 5, bunk 4, historic 2, render 1.

- Labels follow `guides/p7_photos.md` and are written from the copies P7 sees: the Media service's processing (faces,
  text and screens blurred) and a 1,024 px copy. Values can be null (not determinable: `not_visible` is right), `*` (not
  scored), with `<field>_alt` for other acceptable readings and `<list>_maybe` for objects that are hard to see.
- Each row keeps the file name, its SHA-256 and the source (Commons page, author, licence); `p7_photos_v1_sources.md`
  is the attribution list. Licences: CC BY-SA 29 (versions 2.0 to 4.0), CC BY 10, public domain 6, CC0 5.
- Re-label: 10 photos (seed 20261005) labelled blind by a second model-based annotator; numbers in the guide; 8 labels
  changed by the three rules that settled the conflicts (`relabel/p7_photos_v1_adjudication.json`).
- `p7_photos_v1_pairs.json`: four pairs of candidates that show the same room twice, for the pHash report.
- Bias: Commons photos are cleaner, better lit and more often professional than listing photos; several are hotel or
  show-flat rooms. Accuracy measured here probably overstates accuracy on real listings (D-069).

## match_agent v1 (`match_agent_v1.jsonl`)

Conversations for the A3 Match agent (D-084), read by `scripts/agent_bench.py` from the file (not stored in
`eval.datasets`). 27 conversations, 42 turns, account country TN, places from the gazetteer that have synthetic
listings around them (Ennasr, La Marsa, INSAT, Lafayette, ENIT, Ariana, Manouba, Aouina, Lac 2, Bardo, El Menzah 6):

| Kind | Conversations | What is expected |
|---|---|---|
| single search (`s01`-`s12`) | 12 (7 French, 2 English, 2 Tunisian in Latin letters, 1 Arabic) | `search_listings`; place, budget or move-in month of the search |
| follow-up (`f01`-`f08`) | 8 | turn 2 changes the budget, the date or the place; the search keeps what turn 1 said |
| one result (`d01`-`d05`) | 5 | turn 2 asks about result N: `listing_details` with N (scored only when turn 1 found N results) |
| no tool (`o01`, `o02`) | 2 | turn 2 closes the conversation: no tool call |

Each turn has `expect`: `tool`, and where it applies `anchor` (contained in the place the search used, accents
ignored), `budget` (main units, TND), `month` (of `move_in_from`), `number`. Written by me with the set; no second
annotator, no native-speaker check of the Tunisian and Arabic turns.
