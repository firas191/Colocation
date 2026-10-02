Hand-written after reading the run of job `92e8c6cd` (dump `reports/phase2/eval-92e8c6cd.json`, read against the
exported texts). No retrieval parameter was tuned on this gold set; the matrix ran once with the settings fixed in
phase 2 (500/50 windows, 150-400 tokens for B, 50 candidates per leg, RRF constant 60).

**Tried and dropped during phase 2**

- Sending all embedding requests of a document at once (the HTTP node's default): the largest document timed out on
  TEI's CPU. Dropped for one request at a time (F-033, D-049).
- Guessing charsets with a detection library: dropped for declared charsets with a UTF-8 validity rule (D-048).
- The Arabic text of law 2004-63 from igppp.tn: its PDF has no usable text layer (F-038); removed. Africa-laws.org's
  copy of the COC: its robots.txt disallows fetching (D-047).
- Expected values in the contract tests that depended on the sandbox's mock tokenizer and empty global corpus
  (F-034): replaced by checks that hold for any tokenizer.

**Seen in this run, not acted on yet** (each is a hypothesis for the next iteration, to be checked with the same gold
set and the bootstrap, not assumed)

1. *The gold set had gaps* (acted on). In 5 of the v1 worst 10 (tn-10, tn-22, tn-24, tn-26, tn-38) a passage that
   answers the question was retrieved at rank 1 to 4 but was not in the gold. Gold set v2 judges every passage in
   the top 10 of the 12 runs (D-052); the v1 report is kept as `docs/RETRIEVAL_EVAL_v1.md`. With v2, Hit@5 and MRR
   rise in every configuration (same retrieved lists) and the A against B intervals still contain 0 for dense and
   hybrid search.
2. *Vocabulary gap between everyday questions and the code.* The COC says bailleur, preneur, prix, chose louée;
   questions say propriétaire, locataire, loyer, logement (tn-04, tn-05). Candidates: query rewriting into the code's
   terms (spec 10.5 step 6) or a small synonym list in `kb.lex_query`.
3. *The lexical leg can push a correct dense hit out* (tn-32: rank 1 in B dense, absent from B hybrid; tn-09: rank 1
   dense, rank 5 hybrid), and on transliterated questions it matches only the token "el". In the averages this is not
   established: with v1 one of the 16 secondary intervals excluded 0 (A / bge-m3, recall@5, hybrid minus dense), as
   expected by chance; with v2 none does. Candidates: weighted RRF, dropping one- and two-letter Latin tokens from
   `kb.lex_query`.
4. *Transliterated Tunisian is not served.* Hit@5 was 0.25 in every configuration with v1; with v2 it is 0.25 to
   0.50 in hybrid search, and the hits come from the French words of tn-38 and tn-40 ("colocataire", "facebook"),
   not from the Tunisian ones. Neither model maps arabizi onto the Arabic or French text. Candidates: transliteration to Arabic script before embedding, or query rewriting.
5. *Short chunks attract multilingual-e5-large.* With strategy B, 9 of 48 top-1 results of e5 / dense are under 200
   characters (an article number with one line, a footer, a PDF heading such as "ET DELAIS DE PRESCRIPTION"); with
   bge-m3 / B it is 1, with strategy A 0. Strategy B keeps units down to 5 tokens. Candidate: merge units under a
   minimum across headings, or drop heading-only units.
6. *Strategy B's article detection runs on every document.* In the 2014 ministry report a line "Article 74 de la LF
   2014" opens an "article" that runs to the end of the report, so its chunks all carry the reference "art. 74".
   Candidate: detect articles only in `primary_law` sources.
7. *Leftover page chrome.* The notaire page's end marker is no longer on the page, so its footer ("Vous aimez nos
   contenus ?") is kept and is retrieved by e5 for unrelated questions.
8. *One source holds two regimes.* `tn-loi-76-35-recueil` is the official collection of rental laws: law 76-35
   (housing) and law 77-37 (commercial leases) in one document. For tn-07 and tn-11 the commercial-lease articles on
   subletting and renewal rank above the answer. Candidate: split the collection into one source per law, with the
   regime in the metadata, so retrieval or the answerer can filter.
