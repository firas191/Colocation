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
| P1_router | A0 orchestrator | v1 zero-shot baseline; v2 rules, guardrails, 8 few-shot examples | 1 |
| P2_profile_extractor | A2 profile | v1 baseline without unit rules; v2 money, date and preference rules, 5 few-shot examples | 1 |
