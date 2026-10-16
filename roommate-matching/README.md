# Roommate matching (colocataire matching) — n8n Cloud

Author: Yosr. No-code, agentic part of the Coloc project: a user builds a flatmate profile by chatting
with an AI agent, the agent finds the most compatible flatmates in the same zone, puts two people in
contact only with mutual consent, and generates a shared living plan once they decide to live together.

Built and tested on **n8n Cloud** (editor only, no Code nodes). It is independent from the generated
workflows in `n8n/workflows/` (which come from `n8n/build.py`): nothing here is touched by the build.

## Flow

```
Chat (public chat page)
  └─ 01 Profile onboarding  (AI Agent + memory)
        ├─ tool save_profile      → Data table "profiles" (insert)
        ├─ tool find_matches      → 02 Matching
        └─ tool request_contact   → 03 Contact request → 04 Consent (runs in background)

04 Consent: email to the chosen person with Accepter / Refuser buttons (Gmail "send and wait")
  ├─ accepted → "C'est un match" email to both, with a button to the 05 form
  └─ refused  → polite email to the requester

05 Living plan (n8n form): the other person confirms by email, then the LLM writes the plan
  (rent split, chores, house rules…), it is emailed to both, and both profiles go to status "found".
```

| File | Workflow name in n8n | Trigger | Role |
|---|---|---|---|
| `workflows/01_profile_onboarding.json` | Coloc – Profile onboarding | Chat Trigger (public) | Conversational agent: asks the questions, saves the profile, calls the tools |
| `workflows/02_matching.json` | Coloc – Matching | Called by 01 | Same zone + `searching`, budget overlap filter, then LLM scores 0–100 and returns the top 5 (structured output) |
| `workflows/03_contact_request.json` | Coloc – Contact request | Called by 01 | Starts 04 without waiting, answers the agent immediately |
| `workflows/04_consent.json` | Coloc – Consent | Called by 03 | Consent email with buttons, then match / refusal emails (HTML) |
| `workflows/05_living_plan.json` | Coloc – Living plan | n8n Form | Confirmation, AI living plan email, status update |
| `data/profiles_seed.csv` | — | — | Test profiles for the `profiles` data table |

## Setup on another n8n instance

Credentials, data tables and IDs are never included in n8n exports, so after importing:

1. **Credentials**: create Groq (free key at console.groq.com), Google Gemini (aistudio.google.com) and Gmail
   (Sign in with Google), then select them in every model and Gmail node.
2. **Data table** `profiles` with these columns, then reselect it in every Data table node:

   | Column | Type | Column | Type |
   |---|---|---|---|
   | name | String | sleep_schedule | String |
   | email | String | guests | String |
   | zone | String | noise_tolerance | Number (1 = needs silence, 5 = noise is fine) |
   | budget_min | Number | works_from_home | Boolean |
   | budget_max | Number | personality | String |
   | move_in_date | Date | dealbreakers | String |
   | gender | String | ok_with_smoker | Boolean |
   | smoker | Boolean | ok_with_pets | Boolean |
   | pets | Boolean | status | String (`searching` / `found`) |
   | cleanliness | Number (1–5) | | |

   Import `data/profiles_seed.csv` (or add a few rows by hand) to test matching.
3. **Import order**: 02, 04, 03, 05, then 01. After importing, reselect the sub-workflow in:
   `find_matches` → Coloc – Matching, `request_contact` → Coloc – Contact request,
   and in 03 the "Call 'Coloc – Consent'" node → Coloc – Consent.
   (Importing with the CLI, `n8n import:workflow --separate --input=roommate-matching/workflows`, keeps the
   original IDs, so these links may already be correct.)
4. **Publish** 02, 03, 04 and 05 (sub-workflows only run when published), and 01 to get the public chat URL.
5. **Form link**: open 05 → "On form submission" → copy the Production URL, and paste it in the
   button `href` of the "Send a message" node (match email) in 04. Republish 04.

## Models (free tiers)

- Agent (01): Gemini or Groq `openai/gpt-oss-120b`. Gemini preview models allow very few requests per day.
- Matching (02): Groq `qwen/qwen3.8-27b`. Living plan (05): Groq.
- Groq free tier limits tokens per minute per model, so each LLM node uses a different model. If a limit is hit,
  enable **Retry On Fail** (3 tries, 5000 ms) in the node settings, and reduce Simple Memory to ~8 messages.

## Testing with one inbox

Gmail ignores everything after `+` in an address, so `you+amira@gmail.com`, `you+sarra@gmail.com`… all arrive in
`you@gmail.com`. The seed profiles use this, so every email of the flow can be tested from a single inbox.
Profiles still on `@example.com` receive nothing.

Full test: in the chat, create a profile in Ariana → the agent lists matches → "je veux contacter Amira" →
click Accepter in the email → click the green button in the match email → fill the form → click Je confirme →
the living plan arrives and both profiles switch to `found` (set them back to `searching` to test again).
