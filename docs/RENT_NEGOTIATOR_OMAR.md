# Omar's Rent Negotiator (A4)

The source of truth is `db/migrations/0017_rent_negotiator.sql`. Four signed n8n API workflows in `n8n/build.py` expose creation, reading and participant decisions. The workflows are generated into `n8n/workflows/`. APInex is used only by A4; existing Ollama and A3 Match Agent are untouched.

## Data and authority

`app.negotiations` links a renter, a published real listing and its verified owner. It records asking rent, target, maximum budget, proposed amount, counter amount, currency, round, status and version. `app.negotiation_events` holds ordered immutable actions, actor IDs, amounts, timestamps and metadata. Amounts are integer minor units: **1 TND = 1,000 millimes**. A database row lock serializes transitions. The caller supplies the expected version; stale or duplicate decisions fail.

The renter can approve or reject only the exact proposed amount, currency and round. A verified listing owner can accept, reject or counter only after renter approval. A first counter advances to round 2; a second counter becomes `unresolved`. An accepted offer is `tentative_agreement` pending identity, property and signed rental terms. The workflows never send a message to a landlord. The old prototype's Wait forms are demonstration only and do not authenticate anyone.

## Nodes and AI

`wf.api.negotiations_create` validates the minor-unit budget, calls `app.negotiation_create`, sends only asking, target, maximum, currency and round to the APInex OpenAI-compatible Chat Model, guards the JSON response, then records the proposed amount. An invalid or unavailable model response produces a deterministic target-based draft and `model_used: false`; it is never reported as an AI success. `wf.api.negotiations_landlord_decision` drafts round 2 after an authorized first counter. The database independently rejects an over-budget amount or illegal transition. The model has no tools, memory, property prose or permission to send messages. The event ledger is authoritative memory.

## API

All routes use the signed gateway in `docs/API_SIGNING.md`. State-changing calls require `X-Idempotency-Key`.

| Route | Caller | Body |
|---|---|---|
| `POST /v1/negotiations` | renter | `listing_id`, `target_minor`, `max_minor` |
| `GET /v1/negotiations/{id}` | participant | none |
| `POST /v1/negotiations/{id}/renter-decision` | renter | `version`, `action` (`approve` or `reject`), `offer_minor`, `currency`, `round` |
| `POST /v1/negotiations/{id}/landlord-decision` | verified owner | same fields; action `accept`, `reject` or `counter` |

For `counter`, `offer_minor` is the owner's counter amount. For other decisions it must equal the current proposed amount. The current version and offer come from `GET`. A new idempotency key is needed for each distinct action.

## Setup

1. Keep the API key in `.env` as `APINEX_API_KEY`. Set `APINEX_BASE_URL` if different from the default in `.env.example`. `n8n-setup` imports an encrypted OpenAI credential named **APInex (A4 only)**. The model is the nonsecret `app.settings` key `rent.negotiator_model` (default `free/gpt-6-luna`); change it with SQL after verifying the provider catalog. Never put a key in workflow JSON.
2. Start Docker Desktop, run `docker compose up -d`, then `docker compose up -d --force-recreate n8n-setup n8n proxy`. Open `http://localhost:5678` and inspect the four `wf.api.negotiations_*` workflows and the APInex credential.
3. Verify a live APInex request and the model's JSON response. Only then enable A4: `docker exec -u postgres fs-postgres psql -d flatshare -c "update app.settings set value='true' where key='rent.negotiator_enabled'"`.
4. Grant `terms`, `privacy` and `cloud_llm_processing` consent through the existing consent API before creation. The verified listing owner also needs cloud consent before a counter can start round 2. Use a published nonsynthetic listing with an owner whose `verified_level >= 1`.

## Verification and limits

Run `python n8n/build.py --check`, `node --test n8n/tests/*.test.js` and `docker exec -u postgres fs-postgres bash /flatshare/scripts/db-test.sh`. A live signed API demonstration is in `docs/OMAR_DEMO.md`. An n8n import, database migration, real APInex compatibility and a full end-to-end run require a working Docker stack and provider key. The prototype's manual and form triggers remain in `n8n/prototypes/` as reference; they are not published. Telegram `/negocier` and A0 natural-language routing are not added; both would require their own identity and prompt regression work.
