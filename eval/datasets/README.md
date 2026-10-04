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
