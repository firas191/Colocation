# Evaluation datasets

`manifest.json` lists the datasets that `scripts/kb.py seed` loads into `eval.datasets` and
`eval.queries`. A dataset with evaluation runs cannot change silently: change the version, or
pass `--force`.

## tn_retrieval v1 (`tn_retrieval_v1.jsonl`, written by `build_tn_retrieval_v1.py`)

48 questions about renting and flatsharing in Tunisia, written by reading the texts exported
after the TN ingestion of T-27, with the extraction changes of T-28 applied, before any retrieval
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
