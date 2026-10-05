# Runbook

Commands assume the repository root. On Windows use PowerShell; `docker compose` is the same everywhere.

## Start, stop, reset

| Task | Command |
|---|---|
| First start (creates `.env` if missing, builds, starts, runs every check) | `powershell -ExecutionPolicy Bypass -File scripts\windows\verify.ps1` |
| Start (CPU) | `docker compose up -d` |
| Start with the NVIDIA GPU | `docker compose -f docker-compose.yml -f docker-compose.gpu.yml up -d` |
| Status | `docker compose ps -a` |
| Stop, keep data | `docker compose down` |
| Delete all data (database, storage, models, n8n) | `docker compose down -v` then delete `secrets\api-clients.env` |

One-shot services run on every `up`: `db-bootstrap` (migrations are idempotent, existing API keys are kept),
`n8n-setup` (re-imports credentials and workflows with the same ids, then publishes them), `ollama-pull`.

## Logs

- Service logs: `docker compose logs -f n8n` (or `postgres`, `proxy`, `garage`, `ollama`).
- API requests: table `ai.executions` (one row per request: workflow, status, latency, error code and reason).
  `docker exec -u postgres fs-postgres psql -d flatshare -c "select started_at, workflow, status, latency_ms, error from ai.executions order by started_at desc limit 20"`
- Failed n8n executions (with input data, kept 7 days): n8n editor, http://localhost:5678, Executions.

## Changing a workflow

1. Edit `n8n/build.py` (graph, SQL) or `n8n/src/nodes/*.js` / `n8n/src/lib/*.js` (Code node logic).
2. `python n8n/build.py` (writes `n8n/workflows/*.json`); `node --test n8n/tests/*.test.js kb/tests/*.test.js eval/tests/*.test.js`.
3. `docker compose up -d --force-recreate n8n-setup n8n` (imports and publishes, restarts n8n).
4. Run the contract tests (below).

A change made in the n8n editor is lost at the next `n8n-setup` run unless it is ported back to the source files.
`python n8n/build.py --check` fails when committed JSON and sources differ.

## Database changes

Add `db/migrations/NNNN_description.sql` with `-- migrate:up` / `-- migrate:down`, add or extend a
pgTAP file in `db/tests/`, then run `docker exec -u postgres fs-postgres bash /flatshare/scripts/db-test.sh`
(builds a throw-away database `flatshare_test` from all migrations and runs every test file).
Never edit a migration that has been applied on a machine you keep.

## Tests

| Suite | Command |
|---|---|
| Database (pgTAP) | `docker exec -u postgres fs-postgres bash /flatshare/scripts/db-test.sh` |
| JavaScript unit | `docker compose run --rm --no-deps -v "${PWD}:/flatshare:ro" --entrypoint sh n8n -c "node --test /flatshare/n8n/tests/*.test.js /flatshare/kb/tests/*.test.js /flatshare/eval/tests/*.test.js"` |
| Python unit + contract (through the proxy; includes outage tests that stop containers) | `docker compose --profile test run --rm --no-deps tests pytest -v -rs tests/unit tests/contract` |
| Same without outage tests | add `-k "not down and not unreachable"` |
| Secret scan | `docker compose --profile test run --rm --no-deps tests bash scripts/secret-scan.sh "" .env secrets/api-clients.env` |

The contract tests need `N8N_IMPORT_TEST_WORKFLOWS=1` at `up` time (verify.ps1 sets it) for the error-handler test,
and the fixture server for the ingestion tests: `docker compose --profile test up -d fixtures`.

## Knowledge base and retrieval evaluation (phase 2)

| Task | Command |
|---|---|
| Load sources and gold sets, ingest TN, export texts | `powershell -ExecutionPolicy Bypass -File scripts\windows\kb.ps1 -Step ingest` |
| Only some sources, or re-chunk unchanged ones | add `-Sources "tn-coc-fr,tn-cdet-2017"`, `-Force` |
| Check gold, run the evaluation matrix, write docs/RETRIEVAL_EVAL.md | `powershell -ExecutionPolicy Bypass -File scripts\windows\kb.ps1 -Step eval` (add `-Version 2` for gold set v2) |
| Re-render the report and write the evaluation dump | `powershell -ExecutionPolicy Bypass -File scripts\windows\kb.ps1 -Step report` |
| Score a dump against another gold set, without the stack | `node eval/runners/rescore.js reports/eval/<job>.json eval/datasets/<file>.jsonl kb/packs` |
| Same from any shell | `docker compose --profile test run --rm --no-deps -v "$PWD/kb/packs:/flatshare/kb/packs" -v "$PWD/docs:/flatshare/docs" tests python scripts/kb.py <seed\|ingest\|export\|check-gold\|eval\|report>` |
| Last ingestion result per source | `docker exec -u postgres fs-postgres psql -d flatshare -c "select s.source_key, l.status, l.step, l.detail->>'error' from kb.ingest_log l join kb.sources s on s.id = l.source_id order by l.id desc limit 30"` |

Adding a source is a data change: a line in `kb/packs/<CODE>/sources.csv`, then `kb.ps1 -Step ingest`.
Before changing `extract` options or `kb/lib/text.js`, run `node kb/tools/reextract.js` after an export: it
re-extracts the saved raw HTML pages and lists which stored texts would change.
A gold set is `eval/datasets/<name>_v<version>.jsonl` listed in `eval/datasets/manifest.json`; once a version has
evaluation runs its queries cannot change (bump the version).

## Profile, search and prompt evaluation (phase 3)

| Task | Command |
|---|---|
| Pull the three LLMs, seed datasets and prompts, fetch exchange rates | `powershell -ExecutionPolicy Bypass -File scripts\windows\p3.ps1 -Step setup` |
| Gazetteer (Nominatim, once), synthetic listings, embeddings | `... p3.ps1 -Step geo` |
| P1 and P2 golden sets, versions 1 and 2, on each model; docs/PROMPT_EVAL.md | `... p3.ps1 -Step eval` (options `-Models`, `-Versions`, `-Prompts`) |
| Search latency (200 requests) | `... p3.ps1 -Step bench` |
| Re-render docs/PROMPT_EVAL.md | `... p3.ps1 -Step report` |
| One prompt run from any shell | `docker compose --profile test run --rm --no-deps tests python scripts/p3.py eval --prompt P1_router --versions 2 --models qwen3.5:4b --limit 10` |
| Activate a prompt version | `docker compose --profile test run --rm --no-deps -v "$PWD/prompts:/flatshare/prompts" tests python scripts/prompts.py activate P1_router 2` |
| Change the default model | `update app.settings set value = '"granite4.2:3b"' where key = 'llm.default_model';` |
| Failures of a prompt version | `select category, item_id, left(observed_output, 120) from ai.prompt_failures f join ai.prompt_versions v on v.id = f.prompt_version_id join ai.prompts p on p.id = v.prompt_id where p.name = 'P1_router' and v.version = 1 order by category, item_id;` |

A prompt change is a new file `prompts/<name>/v<N>.md` (D-054); `p3.ps1 -Step eval` (or `-Step setup`, or
`scripts/prompts.py sync`) stores it as a draft. A version that changes the output shape names its own schema file in
its front matter (`schema:`, P2 v3, D-066). Evaluate one new version on the default model with
`... p3.ps1 -Step eval -Models "qwen3.5:4b" -Versions "3"`; the report compares it with the previous version's
stored run. A version becomes active only by changing `active_version` in `prompt.json` (spec 9.5 step 5).
Failed items of a run, with the inputs: `python eval/runners/prompt_failures.py reports/eval/prompts-<stamp>.json --version 3`. Adding a place: a row in `geo/places.csv`, then `-Step geo` (only new rows are fetched).

## Intake and multimodality (phase 4)

| Task | Command |
|---|---|
| Seed the P3 golden set and prompts; download GlotLID and the NER model into the `text_models` volume | `powershell -ExecutionPolicy Bypass -File scripts\windows\p4.ps1 -Step setup` |
| Text service evaluation: PII masking (two sets, with and without NER), language ID (P1 and P2 sets) | `... p4.ps1 -Step text-eval` |
| P3 golden set, one job per version, on the default model; docs/PROMPT_EVAL.md | `... p4.ps1 -Step p3-eval` (options `-Models`, `-Versions`, default 3,4) |
| Room photos for P7 from Wikimedia Commons into `..\photo_bench` (not committed, D-069) | `... p4.ps1 -Step photos-fetch` |
| P7 golden set and prompts; the 50 labelled photos through the Media service into `eval/p7/`; vision check | `... p4.ps1 -Step p7-setup` |
| P7 v1 and v2 on the 50 photos (one job per version); pHash threshold on the same photos | `... p4.ps1 -Step p7-eval` (option `-P7Versions`), then `-Step report` |
| What P7 said about a photo | `GET /v1/listings/{id}`, `media[].analysis.vision`; listing issues starting with `photo` in `extraction.issues` |
| Turn photo analysis off (no usable vision model) | `update app.settings set value = 'false' where key = 'vision.enabled';` |
| Publish listings automatically after the analysis (testing and demonstration only: skips the owner's confirmation and the trust check, D-083) | `docker exec -u postgres fs-postgres psql -d flatshare -c "update app.settings set value = 'true' where key = 'listing.auto_publish';"`; back to `'false'` before real users |
| Why a listing was not published automatically | `GET /v1/listings/{id}`, `extraction.publication.missing` (`rent`, `place`); the bot says it too |
| An availability date removed by the check | `extraction.issues` has `available_from_not_in_text`; the model's value is in `extraction.model_output.available_from` |
| Near-duplicate threshold | `select value from app.settings where key = 'media.phash_max_distance';` (12 since D-082) |
| Analyze one listing by hand | `POST /v1/listings`, then `POST /v1/listings/{id}/analyze`; result in `GET /v1/listings/{id}` (`extraction.issues`) |
| Plausible rent ranges | `select value from app.settings where key = 'listing.rent_range';` (main units per month, D-076) |
| Model calls of a job | `select s.agent, s.model, s.latency_ms, s.error from ai.executions e join ai.agent_steps s on s.execution_id = e.id where e.request_id = '<job id>';` |

## Telegram bot (D-079)

Set it up once:

1. In Telegram, open **@BotFather**, send `/newbot`, choose a display name and a user name ending in `bot`. BotFather answers with a token.
2. Put the token in `.env` (never in a chat, a commit or a screenshot): `TELEGRAM_BOT_TOKEN=<token>`.
3. Optional, so the commands appear in Telegram's menu: send `/setcommands` to @BotFather, pick the bot, and paste
   ```
   annonce - publier une annonce (texte, photo en légende)
   pays - changer de pays (TN, FR, GB)
   moi - mes informations
   aide - aide
   stop - retirer mon accord
   trace - étapes de ma dernière demande (admins)
   ```
4. Run `verify.ps1` (it loads the token into n8n's Telegram credential and starts the `fs-telegram` relay). Then open the bot in Telegram and send `/start`.

| Task | Command |
|---|---|
| Is the relay running? | `docker logs fs-telegram --tail 20` (it never logs the token) |
| Make your account an admin (for `/trace`) | send `/moi` to the bot, then `docker exec -u postgres fs-postgres psql -d flatshare -c "update app.users set role = 'admin' where external_auth_id = 'telegram:<your Telegram id>';"` |
| What the bot did with a message | n8n editor, workflow `wf.channel.telegram`, Executions tab |
| Stop the bot | `docker stop fs-telegram` (messages wait at Telegram for up to 24 h) |
| New token | change `.env`, run `verify.ps1` again |

Every message goes through the same API as a website would, so its trace is in `ai.executions` like any request. Telegram users who have not accepted the consent message get only that message back.

## API keys

- Keys are created by `db-bootstrap` for `website` and `tests`; secrets are appended to `secrets/api-clients.env`.
- New key: `docker exec -u postgres fs-postgres psql -d flatshare -At -c "select secret from sec.create_api_client('name', 'description')"`.
- Revoke: `update sec.api_clients set active = false, revoked_at = now() where key_id = 'name';` (as postgres).
- The website server needs `FLATSHARE_API_BASE`, `FLATSHARE_WEBSITE_KEY_ID`, `FLATSHARE_WEBSITE_SECRET`.

## Settings without restart

Non-secret runtime settings are rows in `app.settings` (rate limits, timestamp window, Ollama URL, model name).
Example: `update app.settings set value = '120' where key = 'gateway.rate_limit_user_per_min';`

## Known gaps

- During a full PostgreSQL outage requests are answered with 503 but not logged (FAILURES F-010).
- `app.idempotency_keys` and `app.rate_counters` grow until the retention workflow exists (phase 7).
- No backup or restore procedure yet (phase 9).
- A job whose n8n process crashes stays `running` until the job reaper exists (phase 4, DECISIONS D-041).
- TEI is not in `GET /v1/health` (D-046).
- No exchange rate for the Tunisian dinar: a TN search with a budget in another currency is not filtered by budget (`fx_rate_unavailable`, D-057).
- Places not in `geo/places.csv` are not found; no street-address geocoding (D-058).
- The request text sent to `/v1/profiles/extract` and `/v1/assistant/message` is not stored; PII masking comes in phase 4.
