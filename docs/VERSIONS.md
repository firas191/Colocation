# Versions

Checked on 2026-09-29. "Pinned in" is the file that fixes the version. Image digests are
not pinned yet: the sandbox cannot reach Docker Hub, so digests are recorded from the
first `verify.ps1` run on the owner's machine (section "Recorded at run time").

## Compose stack (the deliverable)

| Component | Version | Pinned in | How the version was chosen (source, date) |
|---|---|---|---|
| n8n | 2.41.3 | docker-compose.yml `n8nio/n8n:2.41.3` | npm dist-tags `latest` and `stable` = 2.41.3 (`npm view n8n dist-tags`); Docker Hub tag pushed 2026-09-25 |
| n8n task runners | 2.41.3 | docker-compose.yml `n8nio/runners:2.41.3` | must equal the n8n version (n8n docs "set up task runners", fetched 2026-09-29) |
| PostgreSQL | 18 (minor from the base image) | infra/postgres/Dockerfile `postgis/postgis:18-3.6` | 18.6 is the current 18 minor (postgresql.org/support/versioning); major chosen in DECISIONS D-006 |
| PostGIS | 3.6 | same base image (built on `postgres:18-trixie`) | Docker Hub tag `18-3.6` updated 2026-08-10; the 17 images failed (FAILURES F-016, F-017) |
| pgvector | 0.8.x (PGDG package `postgresql-18-pgvector`; the build fails if it is not 0.8) | infra/postgres/Dockerfile | pgvector CHANGELOG: 0.8.6 released 2026-07-29; PGDG lists 0.8.6-1.pgdg13+1 builds; exact version recorded at run time |
| pgTAP, pg_prove | PGDG `postgresql-18-pgtap` (1.3.4-1.pgdg13+1 listed) | not pinned (test tool) | recorded at run time |
| dbmate | 2.36.0 | infra/postgres/Dockerfile `amacneil/dbmate:2.36.0` | npm `dbmate` 2.36.0 (2026-09-19); GitHub latest release |
| Garage | v2.4.1 | docker-compose.yml `dxflrs/garage:v2.4.1` | garagehq.deuxfleurs.fr/_releases.html: v2.4.1, 2026-09-08 |
| Ollama | 0.34.4 | docker-compose.yml `ollama/ollama:0.34.4` | GitHub "latest release" v0.34.4 (2026-09-23); newest stable tag on Docker Hub; a third-party tracker listed 0.35.0 on 2026-09-28 that is not on Docker Hub yet |
| Embedding model | `bge-m3` (Ollama library) | `.env` `EMBED_MODEL` | spec default; model digest recorded at pull time |
| Text Embeddings Inference (CPU) | 1.9.4 | docker-compose.yml `ghcr.io/huggingface/text-embeddings-inference:cpu-1.9.4` | GitHub releases page: v1.9.4 marked Latest (read 2026-10-01); supported-models page lists the `cpu-1.9` image family |
| multilingual-e5-large | revision `3d7cfbdacd47fdda877c5cd8a79fbcc4f2a574f3` | docker-compose.yml `--revision`, `ai.models.revision` | Hugging Face API `sha` for intfloat/multilingual-e5-large, read 2026-10-01 (licence MIT) |
| Local LLM candidates (phase 3) | `qwen3.5:4b` (3.4 GB), `granite4.2:3b` (2.2 GB), `phi4-mini:3.8b` (2.5 GB) | `ai.models`, `scripts/windows/p3.ps1 -Models` | ollama.com/library tag pages read 2026-10-02 (sizes as listed there); Ollama tags are not immutable, so the digests are recorded at pull time (`p3.py models`), DECISIONS D-053 |
| Caddy | 2.11.4 | docker-compose.yml `caddy:2.11.4-alpine` | Docker Hub tag updated 2026-09-23 |
| Redis (profile `queue` only) | 8.10.2 | docker-compose.yml `redis:8.10.2-alpine` | Docker Hub tag 8.10.2, 2026-09-24 |
| Test runner image | Python 3.12.14-slim, docker CLI 29.8.1 | infra/tests/Dockerfile | Docker Hub tags 3.12.14-slim (2026-09-25), 29.8.1-cli (2026-09-18) |
| Python test libraries | httpx 0.28.1, pytest 9.1.1, psycopg[binary] 3.3.6, detect-secrets 1.5.0, openapi-spec-validator 0.9.0, jsonschema 4.26.0, PyYAML 6.0.3 | infra/tests/requirements-dev.txt | latest on PyPI on 2026-09-29 (`pip index versions`) |

## Cloud sandbox (where phase 0 and 1 tests ran)

Different from the compose stack because the sandbox cannot pull images (FAILURES F-002).

| Component | Version | Source |
|---|---|---|
| OS | Ubuntu 24.04.4 LTS, 2 vCPU, 7.8 GB RAM, no GPU | `uname`, `free` |
| PostgreSQL | 16.13 | Ubuntu package `postgresql-16 16.13-0ubuntu0.24.04.1` |
| pgvector | 0.6.0 | Ubuntu package `postgresql-16-pgvector 0.6.0-1` (the version the spec's baseline test used) |
| PostGIS | 3.4.2 | Ubuntu package `postgresql-16-postgis-3 3.4.2+dfsg-1ubuntu3` |
| pgTAP / pg_prove | 1.3.2 / 3.36 | Ubuntu packages |
| dbmate | 2.36.0 | npm `dbmate@2.36.0` (static binary, sha256 47e284b3…ce) |
| n8n | 2.41.3 | npm `n8n@2.41.3` |
| Node.js | 24.21.0 | npm `node-linux-x64@24.21.0` (n8n 2.41.3 requires Node >= 24) |
| Caddy | 2.6.2 | Ubuntu package (older than the pinned 2.11.4) |
| Redis | 7.0.15 | Ubuntu package, used only for the F-004 spike |
| Python | 3.11.15 | system |
| Ollama, object storage | not available | replaced by `tests/mocks/deps_mock.py` for the health tests only |

## Recorded at run time

From `reports/verify-20260929-225540/verify.log` on the owner's PC (2026-09-30T00:05+01:00),
steps "component versions", "build images" and "GPU visible to Docker".

| Item | Recorded value |
|---|---|
| Host | Windows 11 Pro, Docker client/server 29.7.2, Docker Compose v5.4.0 |
| GPU seen by Docker | `GPU 0: NVIDIA GeForce GTX 1650 with Max-Q Design` (`nvidia-smi -L`); 4 GB VRAM per env-check (D-025). GPU use by Ollama: not measured |
| PostgreSQL | 18.6 (Debian 18.6-1.pgdg13+2) |
| Extensions (`pg_extension`, app database) | citext 1.8, pg_trgm 1.6, pgcrypto 1.4, plpgsql 1.0, postgis 3.6.4, unaccent 1.1, vector 0.8.6 |
| Packages installed in the image build | postgresql-18-pgvector 0.8.6-1.pgdg13+2, postgresql-18-pgtap 1.3.4-1.pgdg13+1, libtap-parser-sourcehandler-pgtap-perl 3.37-1.pgdg130+1 |
| Migrations applied | 0001 to 0006 |
| n8n | 2.41.3 (`n8n --version` in fs-n8n) |
| Ollama | 0.34.4 (`ollama --version`) |
| Embedding model | `bge-m3:latest`, id `790764642607`, 1.2 GB (`ollama list`) |
| dbmate base image | `amacneil/dbmate:2.36.0@sha256:520c740c6e0ad73fde2cd1ea7e2b779aaf789d22aca8858f87a478e7094535fb` |

Image ids (`docker image inspect`; for pulled images the RepoDigest has the same value):

| Image | Id |
|---|---|
| flatshare/postgres:18-3.6-pgvector0.8 (built locally) | sha256:5cfca21ba04b4ea3c9f2e80194992b5c55768947f7942586ab6f93999cff15b5 |
| dxflrs/garage:v2.4.1 | sha256:9c96caa2612d3411acc5b0e6701fb238dbfba33e533a6d7d3d811a4b12d0d020 |
| ollama/ollama:0.34.4 | sha256:8262851b2846b87c649eddf3e76beb270c52f4d1bc94559f47efde16b0841551 |
| n8nio/n8n:2.41.3 | sha256:fdce8f852ac7abbb2f31a53170bc3c2eeec45c37c0692a99f2d6c11b3822cd98 |
| n8nio/runners:2.41.3 | sha256:1522f8179b76adcdb7900864c18b2ec57d63af472baeed874ed220bab3e66ecc |
| caddy:2.11.4-alpine | sha256:6aeddd44c3078b0f9a35206472a11420648a79c184603ef95957d0a20044cb2b |
| flatshare/tests:py3.12.14 (built locally) | sha256:863ce4f4c938f51cf9b064476dd2b671b688d4df296c3a16bec1e6d13236f635 |

Tags stay the pin in `docker-compose.yml`; pinning by digest is part of the phase 9 hardening.

TEI, from `GET /info` on the owner's PC (`reports/verify-20261001-021026/verify.log`, 2026-10-01):
version 1.9.4 (image sha e80ef22), model `intfloat/multilingual-e5-large` at `3d7cfbdacd47fdda877c5cd8a79fbcc4f2a574f3`,
dtype float32, pooling mean, max_input_length 512, max_batch_tokens 16384, max_client_batch_size 64, auto_truncate true.
First start (model download) took 1661 s.

## Website (platform P1, `web/package.json`, checked 2026-10-16)

Rule (D-098): the newest release published at least 7 days before 2026-10-16 (`npm view <package> time`), except
Next.js 16.4.1 and React 19.3.1, the releases of the Next.js security update of 2026-10-14
(https://nextjs.org/blog/nextjs-security-update-october-14-2026).

| Component | Version | Source |
|---|---|---|
| Node.js (image) | `node:24.21.0-bookworm-slim` | Docker Hub tag, updated 2026-10-06 |
| next | 16.4.1 | npm, 2026-10-14 (security release) |
| react, react-dom | 19.3.1 | npm, 2026-10-15 |
| better-auth | 1.7.7 | npm, 2026-09-30 |
| next-intl | 4.14.9 | npm, 2026-10-02 |
| tailwindcss, @tailwindcss/postcss | 4.3.3 | npm, 2026-07-16 |
| pg | 8.23.1 | npm, 2026-09-30 |
| nodemailer | 7.0.13 | npm, 2026-01-27 |
| @fontsource/ibm-plex-sans, @fontsource/ibm-plex-sans-arabic | 5.3.0 | npm, 2026-07-19 |
| clsx, server-only | 2.1.1, 0.0.1 | npm |
| typescript | 5.9.3 | npm (7.x not used, D-098) |
| vitest, vite | 5.0.3, 8.3.4 | npm, 2026-09-30, 2026-10-08 |
| @playwright/test | 1.64.0 | npm, 2026-10-07; e2e image `mcr.microsoft.com/playwright:v1.64.0-noble` (not checked from the sandbox: the registry is not reachable there; `verify.ps1` checks the tag) |
| maplibre-gl | 6.13.0 | npm, 2026-10-06 (6.14.0 of 2026-10-11 is less than 7 days old); platform P2 map. Draws Arabic itself, so no right-to-left plugin |
| pmtiles | 4.5.0 | npm, 2026-08-10; the map reads the country file with range requests |
| @protomaps/basemaps | 5.7.2 | npm, 2026-03-10; map style layers (flavour "light", labels in the page's language) |
| Map fonts and icons | basemaps-assets `main` | fetched 2026-10-16 from https://github.com/protomaps/basemaps-assets into `web/public/map` (Noto Sans glyph ranges, sprites v4) |
| go-pmtiles (owner's PC, `scripts/windows/map.ps1`) | 1.31.2 | GitHub release of 2026-07-22, Windows x86_64 zip, SHA-256 a658baa4d7e55020aef6ca17bd9ff9faa1582671266b36f58c52db0ac8e785a1 (computed 2026-10-16; the release publishes no checksum) |
| @axe-core/playwright | 4.13.0 | npm, 2026-08-11 |
| sharp (dependency of next) | 0.35.5 | resolved by npm; the version the security update names |
| Mailpit | `axllent/mailpit:v1.31.4` | Docker Hub tag, 2026-10-03 |

The cloud sandbox ran the website on Node 24.22.0 (npm package `node-linux-x64`), Chromium 1194 from `/opt/pw-browsers`.

