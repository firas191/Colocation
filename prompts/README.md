# Prompts

The source of the prompt registry (spec 9.1, DECISIONS D-054). Workflows never read these files:
`scripts/prompts.py sync` (also run by `scripts/p3.py seed`) writes them to `ai.prompts` and
`ai.prompt_versions`, and workflows load the active (or a requested) version with `ai.prompt_for`.

```
prompts/
  schemas/<name>.schema.json      output JSON Schema (also sent to Ollama as "format")
  <name>/prompt.json              agent, role, schema, template variables, golden set, active_version
  <name>/v<N>.md                  front matter + "## system" and "## user" sections
```

Rules checked by `scripts/prompts.py check` and `tests/unit/test_prompts.py`:
- a stored version never changes; a change is a new file `v<N+1>.md` with a changelog that says why;
- temperature 0 (extraction and classification prompts);
- variables are `{{name}}` from the list in `prompt.json`; the user's message sits alone between
  `<message>` and `</message>` (the code also neutralises those tags inside user text);
- no golden-set message appears in a template (few-shot examples are written separately).

Activating a version: `python scripts/prompts.py activate P1_router 2` (updates `prompt.json` and
the database). Spec 9.5: promote only when the golden-set run beats the active version on the
primary metric without a regression on injection or protected-attribute cases.

| Prompt | Agent | Versions | Active |
|---|---|---|---|
| P1_router | A0 orchestrator | v1 zero-shot baseline; v2 rules, guardrails, 8 few-shot examples; v3 clarifying-question path | 2 |
| P2_profile_extractor | A2 profile | v1 baseline without unit rules; v2 money, date and preference rules, 5 few-shot examples; v3 amounts in main units (D-066) | 3 |
| P3_listing_extractor | A1 intake | v1 direct (field list only); v2 normalisation rules (millimes, S+n, T3, scope, bills, deposits in months, dates), 6 few-shot examples; amounts in main units, range check in code (D-076); v3 and v4: v1 and v2 with a short output (F-058) | 4 (D-080) |
| P7_photo_analyzer | A1 intake | v1 open description plus closed lists, every field answered; v2 no free description, "not_visible", a confidence per filled field, rules on people and text (D-081). Image input; contradictions with the listing text computed in code | 1 (not evaluated yet) |
| P6_match_agent | A3 match (AI Agent node) | v1 tools and short answers; v2 plain text, length, alphabet; v3 listing_details first for a numbered result (D-084, D-085). Plain-text answer, numbers checked in code | 3 |
| P11_owner_assistant | A1 owner assistant (AI Agent node) | v1 list the owner's listings first, propose only the fields asked, the owner confirms with a button (D-088). Plain-text answer; the change is checked in the database | 1 (not evaluated yet) |
| P5_legal_answerer | A5 legal (AI Agent node) | v1 search first (at most two), answer only from numbered excerpts with [n], [NOT_FOUND] and [CONFLICT] tokens (D-087). Plain-text answer; citations, abstention and numbers checked in code | 1 (not evaluated yet) |
| P4_trust_assessor | A4 trust (AI Agent node) | v1 rubric with the signal list and caps of spec 12.2, a quote from the listing for every signal, listing text is data (D-107). JSON answer; quotes, caps, score and verdict checked in code | 1 (not evaluated yet) |
| P9_document_agent | A6 document (AI Agent node) | v1 find the kind, read its slots, ask only for the person's values, propose; the template's text is fixed (D-108). Plain-text answer; the proposal is the stored draft, checked against the slots in code | 1 (not evaluated yet) |
