# Coloc, a flatshare platform run by n8n

ESPRIT final project (Advanced Deep Learning, AI automation). People find a room or flatmates in Tunisia, France or
the United Kingdom, then share rent, chores and documents once they live together. All the logic runs in **n8n**
with **PostgreSQL**; the AI agents use local models through **Ollama**; the website (Next.js) only displays pages and
calls the API.

- Repository: https://github.com/firas191/Colocation
- The n8n workflows, exported as JSON: [`n8n/workflows/`](n8n/workflows) (imported into n8n automatically at start)
- What the platform does and how it is built: [`docs/PLATFORM_SPEC.md`](docs/PLATFORM_SPEC.md),
  [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md); decisions in [`docs/DECISIONS.md`](docs/DECISIONS.md), test runs in
  [`docs/TEST_REPORT.md`](docs/TEST_REPORT.md)

## What you need

- Windows 10 or 11 with **Docker Desktop** (WSL 2 backend), and **Git**. Linux or macOS with Docker Engine and
  Compose v2 also works (see the end of this page).
- At least **25 GB of free disk**: the images, the two embedding models (bge-m3, and multilingual-e5-large about
  2.2 GB) and the three language models (about 8 GB). The total was not measured.
- **Internet** for the first start (images, models, packages).
- Optional: an **NVIDIA GPU** that Docker can see. It is detected automatically; without one everything runs on the
  CPU, only slower.
- Free ports on your machine: 3000 (website), 8080 (API), 5678 (n8n editor), 8025 (test mailbox).

## Install and run

Open PowerShell. Each step is one command.

**1. Get the code**

```powershell
git clone https://github.com/firas191/Colocation.git; cd Colocation
```

**2. Build, start and check everything**

```powershell
powershell -ExecutionPolicy Bypass -File scripts\windows\verify.ps1
```

This creates `.env` with random passwords if it does not exist, builds the images, starts every container, downloads
the embedding models, imports the n8n workflows and runs all the checks (database tests, unit and contract tests,
website tests in French, English and Arabic, a secret scan). On the owner's PC a full run took about one hour
(most of it is the first download). The result of each step is in `reports\verify-<date>\summary.txt`.
Use `-Cpu` to ignore the GPU.

**3. Load the language models, the places and the demo listings**

```powershell
powershell -ExecutionPolicy Bypass -File scripts\windows\p3.ps1 -Step setup; powershell -ExecutionPolicy Bypass -File scripts\windows\p3.ps1 -Step geo
```

`setup` downloads the three language models and stores the prompts; `geo` loads the cities and areas of the three
countries (from OpenStreetMap) and creates synthetic listings, marked as test data on the site.

**4. Load the legal sources used by the legal assistant**

```powershell
powershell -ExecutionPolicy Bypass -File scripts\windows\kb.ps1 -Step ingest
```

**5. Optional: the map of the search page**

```powershell
powershell -ExecutionPolicy Bypass -File scripts\windows\map.ps1; powershell -ExecutionPolicy Bypass -File scripts\windows\map.ps1 -Country FR
```

Without it the search works as a list and the map column says the map is not installed.

## Use it

| What | Where |
|---|---|
| The website | http://localhost:3000 (French; `/en` English, `/ar` Arabic) |
| The mails it sends (account confirmation, notifications) | http://localhost:8025 |
| The n8n editor | http://localhost:5678 (create the owner account on the first visit) |
| The API | http://localhost:8080/v1/... (signed requests only, see [`docs/API_SIGNING.md`](docs/API_SIGNING.md)) |

To try it: create an account on the website, open the confirmation mail at http://localhost:8025, accept the terms,
then pick the country and the language in the header. The assistant, flatmates, households and documents are in the
menu. To see the moderation and admin pages, make your account an admin:

```powershell
docker exec -u postgres fs-postgres psql -d flatshare -c "update app.users set role = 'admin' where email = 'you@example.com';"
```

## Start and stop

| What | Command |
|---|---|
| Start (CPU) | `docker compose up -d` |
| Start with the NVIDIA GPU | `docker compose -f docker-compose.yml -f docker-compose.gpu.yml up -d` |
| Stop, keep the data | `docker compose down` |
| Delete all the data | `docker compose down -v`, then delete `secrets\api-clients.env` |

## The AI agents

| Agent | What it does |
|---|---|
| A0 orchestrator | reads each message to the assistant and sends it to the right agent |
| A1 owner assistant | turns "the rent is now 450" into a proposed change the owner confirms |
| A1 intake | reads a new listing's text and describes its photos |
| A2 profile | turns a sentence into search criteria |
| A3 match agent | searches listings for a seeker, asks when something is missing |
| A4 trust check | reads a listing before it is published (rules, then one detector call by default) |
| A5 legal agent | answers rental-law questions from the loaded sources, with citations |
| A6 document agent | prepares household documents (agreement, inventory, rules, living plan) |
| A7 flatmate profile | fills a flatmate profile by chatting, two questions at a time |

Their prompts are in [`prompts/`](prompts), their test sets in [`eval/datasets/`](eval/datasets). The benchmarks run
on the real model with `scripts\windows\p4.ps1` (for example `-Step trust-compare`, `-Step flatmate-bench`); results go
to `reports\eval\`.

## Optional settings

- **Telegram bot**: put the bot token in `TELEGRAM_BOT_TOKEN` in `.env`, then `docker compose up -d`.
- **Real e-mail** instead of the test mailbox: set `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`,
  `SMTP_PASSWORD`, `SMTP_FROM` in `.env`, then `docker compose up -d web`.
- More operations (backups, restore, prompts, settings): [`docs/RUNBOOK.md`](docs/RUNBOOK.md).

## If something fails

- **A step says `ECONNRESET` or another network error** (npm, image download): run `verify.ps1` again; downloads are
  retried and finished steps are quick the second time.
- **A port is already used**: stop the program that uses it (3000, 8080, 5678 or 8025), then start again.
- **No GPU**: add `-Cpu` to `verify.ps1`; everything works, the agents answer more slowly.
- The full log of a run is in `reports\verify-<date>\verify.log`.

## Linux or macOS

```bash
git clone https://github.com/firas191/Colocation.git && cd Colocation
scripts/setup-env.sh
docker compose up -d
```

Then follow [`docs/RUNBOOK.md`](docs/RUNBOOK.md) for the models, places and tests (the same steps as the Windows
scripts, as `docker compose` commands).

## Layout

```
docker-compose.yml   all the services; docker-compose.gpu.yml adds the GPU
n8n/                 workflows (exported JSON), the code of their Code nodes (src), build.py, tests
db/                  PostgreSQL migrations and database tests
web/                 the website (Next.js): pages, components, texts in fr, en and ar, tests
prompts/             the agents' prompts, by version
eval/                test sets and evaluation code
kb/                  legal and practical sources per country
services/            media (photos), text (language and personal data), telegram relay
scripts/             setup and test scripts; scripts/windows/*.ps1 for Windows
tests/               API contract tests, unit tests
docs/                specification, architecture, decisions, test report, runbook, API description (openapi.yaml)
```
