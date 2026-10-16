# Platform specification: the website and the new backend features

| | |
|---|---|
| Date | 2026-10-16 |
| Status | P0 approved 2026-10-16. P1 built (T-64); later phases not started. |
| Scope | The whole flatshare life on one website: accounts, search, flatmates, contact and visits, owners, the household after move-in, documents, legal help, moving out, trust, notifications, admin, three languages |
| Builds on | `FLATSHARE_BACKEND_SPEC.md` (sections 0, 2, 4.4, 5.4, 6, 8, 13, 17), `docs/ARCHITECTURE.md`, `docs/AI_AGENTS_EXPLAINED.md`, `docs/API_SIGNING.md`, `docs/openapi.yaml`, `docs/DECISIONS.md` up to D-094 |

Phases in this file are numbered P0 to P12, because this first one was called P0. Prompts are always written with
their full name here (`P5_legal_answerer`, not "P5") so that "P5" never means two things.

Contents

1. What exists today
2. Rules for the new work
3. Feature map
4. Where an AI agent is used and where not
5. How this plan fits the remaining backend phases
6. Website stack
7. Data model for the new parts
8. API conventions for the new endpoints
9. Phases, definitions of done and tests
10. Risks and points to decide later
11. Sources

---

## 1. What exists today

Checked on 2026-10-16 against `docs/openapi.yaml`, `n8n/build.py`, `db/migrations/0001` to `0021` and `tests/contract/`.

### 1.1 API (20 operations, all under /v1, all with contract tests)

| Area | Operations |
|---|---|
| System | `GET /v1/health` |
| Accounts | `POST /v1/users/sync`, `POST /v1/me/consents` |
| Profile and search | `POST /v1/profiles/extract`, `PUT /v1/profiles/me`, `GET /v1/search` |
| Assistant | `POST /v1/assistant/message` (orchestrator, Match agent, Legal agent, owner assistant) |
| Listings | `POST /v1/listings`, `GET /v1/listings/{id}` (owner view only), `PATCH /v1/listings/{id}`, `POST /v1/listings/{id}/media/presign`, `POST /v1/listings/{id}/analyze` |
| Jobs | `GET /v1/jobs/{id}` |
| Admin | `POST /v1/admin/kb/ingest`, `POST /v1/admin/eval/runs`, `GET /v1/admin/eval/runs/{id}`, `POST /v1/admin/eval/prompt-runs`, `POST /v1/admin/listings/embed`, `POST /v1/admin/fx/refresh`, `GET /v1/admin/traces/{request_id}` |

The Telegram bot is a client of this same API (D-079).

### 1.2 Tables the platform can reuse

The baseline schema (migration 0001) already has tables that no workflow uses yet:

| Table | Use in this plan |
|---|---|
| `app.reports` | Reports. Today it can only point at a listing; P4 adds columns for users and messages. |
| `app.moderation_queue` | Moderation queue (P8). Its `entity_type` already allows listing, media, message, user and report. |
| `app.trust_reports`, `listings.trust_score`, `listings.trust_verdict` | Trust agent output (P8). |
| `app.audit_log` | Every state change of the new features that a dispute could depend on (decisions, deletions, moderation). |
| `app.users.telegram_chat_id`, `app.users.verified_level` | Telegram notifications (P11) and badges (P8). |
| `app.threads`, `app.messages` | Not reused for messages between users: a thread has one `owner_id`, and its policies give access to that one user only. A conversation needs several members. These tables stay for assistant history, which is not stored today (D-062). |
| `app.generated_documents` | Not reused: its `kind` list (roommate_agreement, inventory_checklist) and its single `user_id` do not fit household documents. Documents go to `home.documents` (section 7). |
| `app.matches` | Not used. |

### 1.3 Gaps found while reading

These are things a website needs that the API does not give yet. Each one is a new endpoint in the feature map.

1. **No public listing page.** `GET /v1/listings/{id}` uses `app.listing_owner_view`: another user gets 404. Search
   results carry the public fields but no photos.
2. **Browsers cannot load photos.** Photos are private objects. Telegram gets them through the relay (D-086). A
   browser needs short-lived signed GET URLs, and the proxy only passes signed PUTs for uploads today.
3. **No way to read the saved profile** (`PUT /v1/profiles/me` exists, no GET), no "my listings", no
   "publish" step (`POST /v1/listings/{id}/submit` is in spec 6.3 but not built; publication only happens with the
   test setting `listing.auto_publish`, D-083), and no API call to cancel an owner assistant proposal (only the
   Telegram button does it).
4. **Row-level security does not protect what n8n reads.** n8n connects as `n8n_worker`, which has `BYPASSRLS`
   (spec 5.4). The RLS policies of migration 0001 only bind `api_user`, which nothing uses. For the new tables, the
   rule "a user only sees their own household" must hold for n8n's queries too, so section 7.1 adds a layer that
   enforces it.
5. **Each parameterised route needs its own Caddy rewrite** (D-024, F-026). With about 90 new operations this is
   error-prone by hand; P1 makes `n8n/build.py` generate the rewrites.
6. **Front-end readiness items of spec 17.1 still open:** response fixtures, storage CORS for browser uploads, the
   BFF environment variables, and the TypeScript signing helper.

### 1.4 Agents and AI calls (unchanged by this plan unless said)

Match agent (A3), Legal agent (A5), owner assistant: n8n AI Agent nodes. P1_router, P2_profile_extractor,
P3_listing_extractor, P7_photo_analyzer: single calls through `wf.llm.call`. Measured results are in
`docs/AI_AGENTS_EXPLAINED.md` and `docs/TEST_REPORT.md`; latency on the PC is 25 to 82 s per agent message (p50),
which shapes the website (section 6.6).

---

## 2. Rules for the new work

1. **The website displays and calls the API. All logic is in n8n and PostgreSQL.** Split calculation, balances,
   reminders, rotations, compatibility, permissions, document filling: workflows and SQL functions. The website
   validates input shape for comfort only (a required field, a date format); the API is the authority and its 422
   details are shown next to the fields.
2. **Browsers never call n8n.** The website server signs every call (`docs/API_SIGNING.md`). The browser talks to
   the website server, and to the storage proxy only with signed URLs (uploads, photos, documents) and for map tiles.
3. **/v1 does not change.** New operations are additive and documented in `openapi.yaml` with a D-xxx entry. A
   change to an existing operation (new query parameter, new behaviour) gets a `/v2` path. Example: more search
   filters become `GET /v2/search`, and `GET /v1/search` stays as it is.
4. **Codes, not sentences.** New responses carry codes and parameters (`expense_created`, `{amount_minor, currency}`);
   the website turns them into French, English or Arabic. Exceptions are channel texts that n8n already writes
   (Telegram, and e-mail from P11) and model answers, which are in the user's language.
5. **Someone else's data answers 404,** not 403, so a user cannot learn that a household, conversation or
   application exists. 403 stays for missing consent and wrong role.
6. **Protected traits are never used** (spec 4.4). Compatibility reads an allowlist of lifestyle fields only;
   there is no column for gender, religion, origin or similar, and no model is asked to guess them. Free text a user
   writes about themselves (a bio) is shown as written and never read by matching.
7. **No model reads private messages or household data by default.** Scam warnings in messages come from phrase
   rules (data, per country). A model sees a message only when a user reports it, and only the reported message.
8. **Money is records only.** Expenses, rent payments, deposits and settlements are what people declare. Nothing
   moves money and nothing asks for payment details.
9. **Legal content comes from primary sources fetched with URL and date.** Document templates, checklists and guides
   are data with their sources. A clause without a source is left out. Every document and guide carries the notice
   that it is not legal advice. A translation we make is labelled as an unofficial translation.
10. **Same evidence habits:** D-xxx for decisions, T-xx in `TEST_REPORT.md` with command and output, F-xxx for
    failures, ARCHITECTURE updated in the phase that changes it. Anything not measured is written "not measured".

---

## 3. Feature map

Legend: **E** exists, **N** new. All pages are new, since no website exists. Paths are the website's; endpoints
are the backend's. Workflow names follow `wf.<area>.<name>`; every endpoint has its own `wf.api.*` workflow, as now.

### 3.1 Accounts and profiles

| Item | Pages | Endpoints | Workflows | Tables | Agent |
|---|---|---|---|---|---|
| Sign up, log in, e-mail check, password reset | `/signup`, `/login`, `/verify`, `/reset` | none: handled by the auth library inside the website server (section 6.3) | — | separate database `auth` **N** | — |
| Platform user after login | (automatic) | `POST /v1/users/sync` **E** | `wf.api.users_sync` **E** | `app.users` **E** | — |
| Consent (terms, privacy, media processing), age 18+ | `/consent` | `POST /v1/me/consents` **E** | `wf.api.me_consents` **E** | `app.consents` **E** | — |
| Who am I: role, consents, counts (unread, households) | header, `/account` | `GET /v1/me` **N** | `wf.api.me_get` **N** | reads existing and new tables | — |
| Lifestyle profile: budget, schedule, cleanliness, smoking, pets, guests, quiet hours, languages | `/profile` | `GET /v1/profiles/me` **N**, `PUT /v1/profiles/me` **E**, `POST /v1/profiles/extract` **E** ("fill from a sentence") | `wf.api.profiles_get` **N**, `wf.api.profiles_me` **E**, `wf.profile.extract` **E** | `app.profiles` **E** | P2 (single call) **E** |
| Roles | — | role in `GET /v1/me` | — | `app.users.role` **E** (user, owner, moderator, admin) | — |
| Delete my account | `/account` | `DELETE /v1/me` **N** (spec 6.3) | `wf.api.me_delete`, `wf.privacy.erase` **N** | `app.erase_user` **E**, extended to the new schemas | — |

Roles: moderator and admin stay staff roles in `app.users.role`. Seeker, owner and flatmate are not stored roles,
because one person is often several of them: "owner" means has listings, "flatmate" means active member of a
household, "seeker" means has a search profile. `GET /v1/me` returns these as flags. The existing `role` values are
not changed (the `/v1/users/sync` schema lists them).

### 3.2 Finding a place

| Item | Pages | Endpoints | Workflows | Tables | Agent |
|---|---|---|---|---|---|
| Search with filters | `/search` | `GET /v1/search` **E**; `GET /v2/search` **N**: adds kind, furnished, bills included, available by, amenities, house rules, bounding box, cursor pages, cover photo URL | `wf.api.search` **E**, `wf.api.search_v2` **N**, `wf.match.search` **E** | `app.search_public` **E**, `app.search_public_v2` **N** | — |
| Map | `/search?view=map` | `GET /v2/search` with `bbox` | same | `public_location` **E** (fuzzed point only) | — |
| Assistant chat | `/assistant` | `POST /v1/assistant/message` **E** | `wf.orchestrator` **E** | — | Match, Legal, owner **E** |
| Listing page with photos | `/listings/[id]` | `GET /v1/listings/{id}/public` **N** (published listings, or the caller's own as a preview; photos as signed GET URLs) | `wf.api.listings_public` **N** | `app.public_cards`, `app.listing_public_photos` **E** | — |
| Favourites | heart button, `/favourites` | `PUT` and `DELETE /v1/me/favourites/{listing_id}`, `GET /v1/me/favourites` **N** | `wf.api.favourites_*` **N** | `social.favourites` **N** | — |
| Saved searches with alerts | `/saved-searches` | `POST`, `GET /v1/me/saved-searches`, `PATCH`, `DELETE /v1/me/saved-searches/{id}` **N** | `wf.api.saved_searches_*` **N**, `wf.alerts.saved_searches` **N** (schedule) | `social.saved_searches` **N** | — |

### 3.3 Finding flatmates

| Item | Pages | Endpoints | Workflows | Tables | Agent |
|---|---|---|---|---|---|
| Flatmate profile (visible or not, short headline and bio, areas, move-in date; lifestyle taken from the profile) | `/me/flatmate-profile` | `GET`, `PUT /v1/me/flatmate-profile` **N** | `wf.api.flatmate_profile_*` **N** | `social.flatmate_profiles` **N**, `app.profiles` **E** | — |
| Browse flatmates, ranked by compatibility | `/flatmates`, `/flatmates/[id]` | `GET /v1/flatmates`, `GET /v1/flatmates/{user_id}` **N** | `wf.api.flatmates_*` **N** | `social.compatibility()` **N** (SQL) | none: SQL |
| "Room free in my flat" | `/households/[id]/room-post` | `POST /v1/households/{id}/room-posts` **N** (creates a `room` or `roommate_wanted` listing linked to the household), then presign, analyze **E**, submit **N** | `wf.api.room_post_create` **N** | `app.listings` **E**, `home.households.listing_id` **N** | P3 **E** |
| Compatibility with a household (shown to the household when someone applies) | application page | inside the application view | — | `social.compatibility_household()` **N** | none: SQL |

Compatibility is a SQL function, not a model. It compares only: schedule, cleanliness, smoking, pets, guests, quiet
hours, languages in common, budget overlap, move-in window and distance between areas. A missing answer counts as
"unknown", not as a mismatch. It returns a score from 0 to 100 and the list of factors with "match", "differs" or
"unknown", so the page can say why. Weights are a setting (`compat.weights`); their starting values are a choice,
not a measurement, and are written as such.

### 3.4 Contact and visits

| Item | Pages | Endpoints | Workflows | Tables | Agent |
|---|---|---|---|---|---|
| Messages (about a listing, an application, a household, or with a flatmate profile) | `/messages`, `/messages/[id]` | `POST /v1/conversations`, `GET /v1/conversations`, `GET` and `POST /v1/conversations/{id}/messages`, `POST /v1/conversations/{id}/read` **N** | `wf.api.conv_*` **N**, `wf.notify.emit` **N** | `social.conversations`, `social.conversation_members`, `social.messages` **N** | — |
| Blocking | menu on a profile or conversation | `POST /v1/me/blocks`, `DELETE /v1/me/blocks/{user_id}`, `GET /v1/me/blocks` **N** | `wf.api.blocks_*` **N** | `social.blocks` **N** | — |
| Owner's visit slots | owner listing page | `PUT`, `GET /v1/listings/{id}/visit-slots` **N** | `wf.api.visit_slots_*` **N** | `social.visit_slots` **N** | — |
| Visit requests and scheduling | listing page, `/visits` | `POST /v1/visits`, `GET /v1/me/visits`, `POST /v1/visits/{id}/decision` (confirm, propose another time, decline, cancel, mark done) **N** | `wf.api.visits_*` **N** | `social.visits`, `social.visit_events` **N** | — |
| Applications (candidatures) | listing page, `/applications`, `/owner/applications` | `POST /v1/listings/{id}/applications`, `GET /v1/me/applications`, `GET /v1/owner/applications`, `POST /v1/applications/{id}/decision` (accept, decline), `POST /v1/applications/{id}/withdraw` **N** | `wf.api.applications_*` **N** | `social.applications` **N** | — |

Accepting an application creates a household invite for the applicant when the listing is linked to a household
(P5); otherwise it only records the decision. Nothing is signed online.

### 3.5 Owners

| Item | Pages | Endpoints | Workflows | Tables | Agent |
|---|---|---|---|---|---|
| Post a listing: text, photo upload, analysis, review, publication | `/owner/new` (steps) | `POST /v1/listings`, `.../media/presign`, `.../analyze`, `GET /v1/jobs/{id}`, `GET /v1/listings/{id}`, `PATCH /v1/listings/{id}` **E**; `POST /v1/listings/{id}/submit` **N** | `wf.api.listings_*`, `wf.listing.analyze`, `wf.intake.photos` **E**; `wf.api.listings_submit` **N** | `app.listings`, `app.listing_media`, `app.media_uploads` **E** | P3, P7 **E**; Trust agent from P8 |
| My listings | `/owner/listings` | `GET /v1/me/listings` **N** | `wf.api.me_listings` **N** | `app.owner_listings` **E** (reused) | — |
| Owner assistant: proposal with Confirm / Cancel | chat panel on `/owner/listings` | `POST /v1/assistant/message` **E** (status `proposed`); confirm: `PATCH /v1/listings/{id}` with `change_id` **E**; cancel: `POST /v1/listing-changes/{id}/cancel` **N** | `wf.owner.agent` **E**, `wf.api.listing_change_cancel` **N** | `ai.listing_changes` **E** | owner assistant **E** |
| Applications inbox | `/owner/applications` | see 3.4 | | | |
| Availability: date, rented, withdrawn, back online | listing edit | `PATCH /v1/listings/{id}` **E** (available_from, status) | **E** | **E** | — |
| Visit availability | listing edit | visit slots, see 3.4 | | | |

Submit (P3) publishes after checking the required fields with the same `app.listing_change_check`. From P8 it starts
the trust job instead, and publication follows the verdict (spec 2.4 journey B). `listing.auto_publish` stays off
for the website.

### 3.6 Living together: the household

| Item | Pages | Endpoints | Workflows | Tables | Agent |
|---|---|---|---|---|---|
| Create, invite by code or link, join | `/households/new`, `/join/[code]` | `POST /v1/households`, `GET /v1/me/households`, `GET /v1/households/{id}`, `POST /v1/households/{id}/invites`, `POST /v1/household-invites/accept` **N** | `wf.api.households_*` **N** | `home.households`, `home.household_members`, `home.household_invites` **N** | — |
| Flatmates of the household (and the owner as a limited member) | `/households/[id]` | in `GET /v1/households/{id}` | | `home.household_members` **N** | — |
| Shared expenses, bill splitting, balances, settlements | `/households/[id]/money` | `GET`, `POST /v1/households/{id}/expenses` (with `preview: true` to see the split before saving), `DELETE /v1/households/{id}/expenses/{expense_id}`, `GET /v1/households/{id}/balances`, `POST /v1/households/{id}/settlements` **N** | `wf.api.expenses_*`, `wf.api.balances_get`, `wf.api.settlements_create` **N** | `home.expenses`, `home.expense_shares`, `home.settlements` **N** | none: SQL |
| Rent and bill reminders; rent payments recorded | `/households/[id]/bills` | `GET`, `PUT /v1/households/{id}/recurring`, `POST`, `GET /v1/households/{id}/rent-payments`, `POST /v1/rent-payments/{id}/confirm` (owner member) **N** | `wf.household.daily` **N** (schedule), `wf.notify.emit` **N** | `home.recurring_items`, `home.rent_payments` **N** | — |
| Chores rota | `/households/[id]/chores` | `GET`, `POST /v1/households/{id}/chores`, `PATCH /v1/households/{id}/chores/{chore_id}`, `POST /v1/chore-assignments/{id}/done` **N** | `wf.api.chores_*` **N**; assignments made by `wf.household.daily` | `home.chores`, `home.chore_assignments` **N** | — |
| Shopping list | `/households/[id]/shopping` | `GET`, `POST /v1/households/{id}/shopping`, `PATCH /v1/households/{id}/shopping/{item_id}` **N** | `wf.api.shopping_*` **N** | `home.shopping_items` **N** | — |
| House rules | `/households/[id]/rules` | `GET`, `PUT /v1/households/{id}/rules` **N** | `wf.api.rules_*` **N** | `home.house_rules` **N** | — |
| Shared calendar | `/households/[id]/calendar` | `GET /v1/households/{id}/calendar?from=&to=`, `POST /v1/households/{id}/events`, `DELETE /v1/households/{id}/events/{event_id}` **N** | `wf.api.calendar_*` **N** | `home.events` **N**; also shows rent due dates, chores, visits, move dates | — |
| Announcements | `/households/[id]` (top) | `GET`, `POST /v1/households/{id}/announcements` **N** | `wf.api.announcements_*` **N** | `home.announcements` **N** | — |
| Repairs and issues, sent to the owner | `/households/[id]/issues` | `GET`, `POST /v1/households/{id}/issues`, `POST /v1/issues/{id}/updates` (status, comment), `POST /v1/households/{id}/media/presign` (photos) **N** | `wf.api.issues_*` **N**; photos through `wf.intake.photos` **E** (blur, EXIF removed) | `home.issues`, `home.issue_events` **N** | — |

The owner of the flat can be a member with role `owner`. That member sees announcements, issues, rent payments and
documents, and not the flatmates' private expenses, chores or shopping list (section 7.3).

### 3.7 Documents, generated per country

| Item | Pages | Endpoints | Workflows | Tables | Agent |
|---|---|---|---|---|---|
| Templates available for the household's country, with their sources | `/households/[id]/documents` | `GET /v1/document-templates?jurisdiction=` **N** | `wf.api.templates_list` **N** | `kb.templates` **N** | — |
| Flatmate agreement, entry inventory (état des lieux), rent receipts, house rules: form path | same | `POST /v1/households/{id}/documents` (202, job), `GET /v1/households/{id}/documents`, `GET /v1/documents/{id}` (status, signed download URL) **N** | `wf.api.documents_*` **N**, `wf.documents.render` **N** (job) | `home.documents`, `home.inventory_items` **N** | — |
| Same, conversation path ("fais-moi un contrat de colocation") | `/assistant`, Telegram | `POST /v1/assistant/message`, intent `generate_document` **E** (answers "not available yet" today) | `wf.documents.agent` **N** | `ai.document_drafts` **N** | **Document agent (A6) N** |
| PDF rendering | — | — | Media service `POST /v1/pdf/render` **N** (compute only) | — | — |

Each PDF shows: the country, the template version, the source list with URLs and retrieval dates, and the notice
(`documents.notice_version`) that it is not legal advice. Rent receipts are made only from rent payments the owner
member confirmed. A document type is offered for a country only when its template has primary sources; otherwise
the page says it is not available for that country.

### 3.8 Legal help

| Item | Pages | Endpoints | Workflows | Tables | Agent |
|---|---|---|---|---|---|
| Questions with numbered sources | `/legal` | `POST /v1/assistant/message` **E**; `POST /v1/legal/ask` **N** (spec 6.3: goes straight to the Legal agent, skipping P1) | `wf.legal.agent` **E**, `wf.api.legal_ask` **N** | `ai.legal_sessions` **E** | Legal agent **E** |
| Guides: deposits, notice, scams | `/guides`, `/guides/[key]` | `GET /v1/guides?jurisdiction=`, `GET /v1/guides/{key}` **N** | `wf.api.guides_*` **N** | `kb.guides` **N** (each paragraph points to `kb.sources` **E**) | — |
| FR and GB packs | — | `POST /v1/admin/kb/ingest` **E** | `wf.kb.ingest` **E** | `kb/packs/FR`, `kb/packs/GB` **N** (data) | — |

### 3.9 Moving out

| Item | Pages | Endpoints | Workflows | Tables | Agent |
|---|---|---|---|---|---|
| Notice and checklist (items per country, each with its source) | `/households/[id]/move-out` | `POST`, `GET /v1/households/{id}/move-out`, `PATCH /v1/households/{id}/move-out/{item}` **N** | `wf.api.moveout_*` **N** | `home.move_outs` **N**, checklist data in the pack | — |
| Exit inventory, compared with the entry inventory | documents page | document kind `inventory_exit`; `GET /v1/documents/{id}/comparison` **N** | `wf.documents.render` **N** | `home.inventory_items` **N** | — |
| Deposit return tracking | move-out page | `GET`, `PUT /v1/households/{id}/deposits/{user_id}` **N** | `wf.api.deposits_*` **N** | `home.deposits` **N** | — |
| Leave the household | move-out page | `POST /v1/households/{id}/leave` **N** (refused with code `balance_not_settled` unless settled or acknowledged) | `wf.api.household_leave` **N** | `home.household_members` **N** | — |

### 3.10 Trust and safety

| Item | Pages | Endpoints | Workflows | Tables | Agent |
|---|---|---|---|---|---|
| Report a listing, a user or a message | report buttons | `POST /v1/reports` **N** | `wf.api.reports_create`, `wf.moderation.enqueue` **N** | `app.reports` **E** (+ columns **N**), `app.moderation_queue` **E** | — |
| Blocking | see 3.4 | | | | |
| Trust check before publication | owner wizard | started by `POST /v1/listings/{id}/submit` **N** | `wf.trust.assess` **N** (job), `wf.ops.benchmarks` **N** (schedule) | `app.trust_reports` **E**, `app.price_benchmarks` **N** | **Trust agent (A4) N** |
| Scam warnings | in conversations, listing page, guide | in message and listing responses (codes) | `wf.msg.scan` **N** (phrase rules) | `kb/packs/*/scam_phrases.csv` **N** (data) | — |
| Moderation queue | `/admin/moderation` | `GET /v1/admin/moderation`, `POST /v1/admin/moderation/{id}/decision` **N** (spec 6.3) | `wf.api.moderation_*`, `wf.moderation.decide` **N** | `app.moderation_queue`, `app.audit_log` **E** | — |
| Verification badges | profile cards, listing page | in `GET /v1/me`, public cards | `wf.api.me_get` **N** | `app.user_badges` **N** | — |

A badge names exactly what was checked: "e-mail address confirmed", "Telegram account linked", "photos checked
by the platform" (trust report), and, if the verified-room proof of spec 11.2 is built, "room photographed with a
code". No identity verification is planned, so no badge says "verified person".

### 3.11 Notifications

| Item | Pages | Endpoints | Workflows | Tables | Agent |
|---|---|---|---|---|---|
| In-app | bell, `/notifications` | `GET /v1/me/notifications?after=`, `POST /v1/me/notifications/read` **N** | `wf.notify.emit` **N** (sub-workflow every feature calls) | `notify.notifications` **N** | — |
| E-mail and Telegram | `/settings/notifications` | `GET`, `PUT /v1/me/notification-preferences`, `POST /v1/me/telegram-link` (one-time code the user sends to the bot) **N** | `wf.notify.dispatch` **N** (schedule; n8n Send Email node and Telegram node), `wf.channel.telegram` **E** (+ link command) | `notify.preferences`, `notify.deliveries` **N** | — |

### 3.12 Admin

| Item | Pages | Endpoints | Status |
|---|---|---|---|
| Request traces | `/admin/traces/[id]` | `GET /v1/admin/traces/{request_id}` | **E** |
| Knowledge base: sources, last ingestion, start an ingestion | `/admin/kb` | `GET /v1/admin/kb/sources` **N**; `POST /v1/admin/kb/ingest`, `GET /v1/jobs/{id}` **E** | partly **E** |
| Evaluation runs | `/admin/eval` | `GET /v1/admin/eval/runs` (list) **N**; create and read **E**; prompt runs **E** | partly **E** |
| Prompt registry (read-only; activation stays a file change, spec 9.5) | `/admin/prompts` | `GET /v1/admin/prompts` **N** (spec 6.3) | **N** |
| Settings (allowlisted keys only) | `/admin/settings` | `GET /v1/admin/settings`, `PUT /v1/admin/settings/{key}` **N** | **N** |
| Moderation | `/admin/moderation` | see 3.10 | **N** |
| Staff roles | `/admin/users` | `PUT /v1/admin/users/{id}/role` **N** (admin only, audit log) | **N** |

### 3.13 Languages, right-to-left and phones

French, English and Arabic for every page, Arabic laid out right to left, every page usable at 360 px width. This is
website work (section 6.4) plus one backend rule: no new user-facing sentence in API responses (rule 2.4).

---

## 4. Where an AI agent is used and where not

The rule of D-084 stays: an AI Agent node where the model must choose between steps, a single checked call where
one structured answer is enough, and plain code or SQL for anything that must be exact.

| Job | How | Why |
|---|---|---|
| Search conversation, legal questions, listing changes | Match, Legal, owner assistant **E** | unchanged |
| **Trust check of a listing (P8)** | **Trust agent A4, new AI Agent node** (`wf.trust.assess`), prompt `P4_trust_assessor` | Which checks matter depends on what the first ones find: a duplicate photo leads to the other owner's listing, a low price to the area benchmark, an "I am abroad" text to the payment wording. Tools: `photo_duplicates` (`app.find_similar_media` **E**), `price_benchmark` **N**, `text_signals` (phrase rules) **N**, `owner_history` **N**, `listing_fields` **N**. The agent returns signals with evidence. **The score and the verdict are computed in code** from the signal table of spec 12.2; `block` needs a hard signal (spec 12.2). The agent has no write tool; publishing, review and rejection are fixed nodes. |
| **Document from a conversation (P9)** | **Document agent A6, new AI Agent node** (`wf.documents.agent`), prompt `P9_document_agent` (spec's P9, slot-limited) | The user says "un contrat de colocation pour notre appart"; the agent reads the household facts, sees which template slots are empty, asks for them, and proposes a filled set. Tools: `household_facts`, `template_slots`, `propose_document`. Like the owner assistant, **it only proposes**: the user confirms, then a fixed job renders the PDF. The legal text of the document is always the template's; the agent fills slot values (names, dates, amounts the user gave, options the template lists) and nothing else. |
| Report triage | fixed workflow: rules set the priority (hard words, repeat reports); optional single call to `P4_trust_assessor` on the reported listing text | One answer is enough; a moderator decides. |
| Compatibility, splits, balances, reminders, chore rotation, deposit arithmetic | SQL functions | Exact and testable; no model. |
| Scam warning in a message | phrase rules from the pack | Private messages are not sent to a model (rule 2.7). |
| Saved-search alerts | fixed schedule + `wf.match.search` **E** | No reasoning step. |

Optional, only if time remains after P12: a household assistant ("j'ai payé 60 dt d'internet" → proposed expense,
Confirm / Cancel), same pattern as the owner assistant. It needs a new P1_router version with a household intent and
its own evaluation, so it is not in the plan.

Each new agent gets what the existing ones have: a prompt in the registry with versions, a trace step per run
(`A4_trust_agent`, `A6_document_agent`, no user text, D-062), a number check on its answer, an on/off setting, a
benchmark script with a labelled set, and an entry in `docs/AI_AGENTS_EXPLAINED.md`.

---

## 5. How this plan fits the remaining backend phases

| Backend spec phase | State today | Where it goes in this plan |
|---|---|---|
| 5 Trust | not started | **P8**. Price benchmark, signals, Trust agent A4, moderation queue and decisions, badges. Reports start earlier (P4), because messaging must launch with a report route (spec 4.5). Acceptance stays the spec's: precision and recall on a labelled trust set. |
| 6 Legal | partly done: Legal agent on the TN pack (D-087, D-089, T-60) | **P9**: `POST /v1/legal/ask`, guides, FR and GB packs from primary sources. `P5b_stance_extractor` and the `P8_verifier` prompt are not planned: the Legal agent's checks in code do the verifier's job today (D-087). They come back only if the evaluation shows a need; listed in section 10. |
| 7 Documents and privacy | not started | Documents: **P9**. Erasure (`DELETE /v1/me`) and retention: **P10**, extended to every new table and to storage. |
| 8 Evaluation and iteration | per-agent benches exist | Each agent phase includes its benchmark (P8: trust set; P9: document agent set). The full ablation matrix and the single-agent comparison of spec 8.5: **P12**. |
| 9 Hardening | not started | Front-end readiness items of spec 17.1: **P1**. Load tests, failure injection, security checks, backup and restore: **P12**. |
| 10 3D | not started | Out of scope, stays last. |

Spec 2.5 listed in-app messaging and tenancy management as non-goals of the backend phase. Firas's platform goal
brings both in (sections 3.4 and 3.6); this is recorded as a decision in P0's DECISIONS entry.

---

## 6. Website stack

### 6.1 Summary

| Part | Choice | Main reason |
|---|---|---|
| Framework and BFF | **Next.js 16 (App Router, TypeScript)**, one Node server that renders the pages and holds the signing secret | Pages, server-side API calls and the BFF in one process; one container on an already loaded PC |
| Authentication | **Better Auth**, self-hosted inside the website server, its own database `auth` | No extra service, no user data leaving the machine, no cost |
| Styling and components | **Tailwind CSS v4** + **shadcn/ui** in RTL mode | Logical classes (`ms-`, `me-`, `start`, `end`) mirror for Arabic without a second stylesheet |
| Map | **MapLibre GL JS** with a **PMTiles** extract of the Protomaps basemap, served by Caddy | No tile server sees users' addresses, no API key |
| Languages | **next-intl**, routes `/fr`, `/en`, `/ar`, `<html lang dir>` | Server components, ICU messages (Arabic plurals), locale routing |
| Client data | React Server Components; **TanStack Query** for polling (jobs, messages, notifications) | n8n cannot push to browsers; polling is simple and testable |
| Forms | react-hook-form + zod for input shape only | Server's 422 details mapped to fields |
| E-mail in development | **Mailpit** container | Sign-up and notification mails visible without a real mail account |
| PDF | WeasyPrint in the Media service (compute only); Gotenberg as fallback | See 6.7 |
| Tests | Vitest, Playwright (Chromium; phone viewport; Arabic), axe-core | |

Exact versions are pinned in `docs/VERSIONS.md` in P1 after checking npm on that day. The Next.js blog lists 16.4
(2026-10-06) and a security update on 2026-10-14; P1 pins the patched release.

### 6.2 Framework and BFF

The website server is the only API client the browser knows. Every page and every browser action goes to a Next.js
server function or route handler, which calls `/v1` with the signing helper (`web/lib/server/api.ts`, marked
`server-only`, so the bundler refuses to ship it to the browser). It adds `X-User-Id` from the session, `X-Client-Ip`,
`Accept-Language`, and passes through an `X-Idempotency-Key` the browser generates per form submission, so a
double click or a retry cannot create two expenses.

Alternatives considered:

- *A separate BFF (Fastify) and a React single-page app (Vite).* Two services and two deployments, and the pages
  render empty until the browser calls the BFF. More moving parts for one person.
- *SvelteKit or Nuxt.* Equally able. Next.js was chosen for the larger set of ready RTL-capable components and
  documentation; this is a preference, not a measurement.
- *Trade-offs of Next.js:* caching defaults must be turned off for API data (every call is `no-store`, as the API
  already answers `Cache-Control: no-store`); the framework changes often, so the version is pinned.

### 6.3 Authentication

Better Auth runs inside the website server with e-mail and password, e-mail confirmation and password reset. Its
tables live in a separate PostgreSQL database `auth` with its own role, so the auth library never touches the app
schemas, and `n8n_worker` cannot read password hashes. After login the server calls `POST /v1/users/sync` with
`external_auth_id = web:<auth user id>` and keeps the platform `user_id` in the session. Roles come from the platform
(`GET /v1/me`), not from the auth database. Admin pages check the role for display; the API enforces it.

Better Auth now also maintains Auth.js, and recommends Better Auth for new projects; Better Auth joined Vercel in
July 2026 and says it stays open source.

Alternatives:

- *Keycloak:* a full identity server with an admin console and standard OIDC. It is a Java service with its own
  database and memory needs on a PC that already runs Ollama, n8n and PostgreSQL; its RAM use on this PC is not
  measured. Worth it if several apps shared the accounts; here there is one.
- *Clerk or Auth0:* hosted. Account data would leave the machine, the demo would need internet, and the free tiers
  have limits. Against the local-first rule of spec 13.3.
- *Auth.js:* maintained but no longer the recommended choice of its own team for new projects.
- *Trade-off of Better Auth:* the auth code runs in our server, so its security updates are our job (pinned version,
  checked each phase).

### 6.4 Styling, layout, right-to-left, phones

Tailwind CSS v4 and shadcn/ui components copied into the repo (they are source files, not a dependency). shadcn/ui
has an RTL mode since January 2026: its CLI writes logical classes (`ms-4` instead of `ml-4`, `text-start` instead of
`text-left`) and flips supported icons. Rules for our own code: only logical classes (a lint rule refuses `ml-`,
`pl-`, `left-`, `text-left`), numbers and amounts wrapped so they read correctly inside Arabic text, icons that show
a direction (arrows, "next") flipped in RTL. Fonts: IBM Plex Sans and IBM Plex Sans Arabic, served by the website
(no font CDN; D-098 says why not the Noto pair). Layout is mobile first: every page is checked at 360 px wide in Playwright. Which digit style the Arabic pages
show (Latin or Arabic-Indic) follows what `Intl` gives for the chosen locale tag; checked in P1.

Alternatives: MUI or Mantine have RTL support too but bring their own styling systems and heavier bundles; plain
CSS modules mean writing every component.

### 6.5 Map

MapLibre GL JS draws vector tiles from one `.pmtiles` file cut from the Protomaps daily build with the `pmtiles`
command (`pmtiles extract <build url> tn.pmtiles --bbox=...`). Caddy serves it with range requests at `/tiles/`.
Markers use `public_location` only (fuzzed by the database); the exact point never reaches the website. The map
credits OpenStreetMap, as `/v1/search` already requires (`data_attribution`).

Trade-offs: the file size of a country extract is not measured yet (P2 records it); styles and fonts for the map
are files we serve too. Alternatives: Leaflet with the openstreetmap.org tile servers (simplest, but their usage
policy does not allow heavy use and every view sends the user's IP to a third party); MapTiler or Mapbox (API key,
quota, cost).

### 6.6 Living with slow agents

On the PC an agent message takes 25 to 82 s at p50 (T-51, T-60, T-61). The chat page shows a waiting state, keeps
the request open on the server (route timeout set above the API's 120 s model timeout), and never retries an
assistant message by itself. Long jobs (listing analysis, document rendering, trust check) are `202` jobs that the
page polls with `GET /v1/jobs/{id}`, as the bot does (D-090). Chat history stays in the browser tab only; the
backend still stores no message text (D-062).

### 6.7 PDF rendering

Documents are HTML filled by n8n from the template and rendered to PDF by a compute endpoint. First choice:
WeasyPrint added to the existing Media service (Python, no browser engine). Arabic text shaping and right-to-left
layout in WeasyPrint are **not verified**: P9 starts with a test PDF in Arabic, French and English, checked by eye
and by extracting the text back. If it fails, the fallback is a Gotenberg container (Chromium-based), larger but
with a browser's text engine.

### 6.8 Where the website runs

`web/` in the same repository. In Docker Compose: a `web` service (`next start` on a production build) and a
`mailpit` service in a `dev` profile. Development can also run `next dev` on Windows against the stack. The browser
reaches two origins: the website, and the storage proxy for signed media and tiles. In a real deployment `/v1`
stays reachable only by the website server; only the media and tile paths are public.

---

## 7. Data model for the new parts

### 7.1 How row-level rules are enforced (the key change)

`n8n_worker` bypasses RLS, so policies alone would not stop a workflow bug from showing household B to a member of
household A. The new tables therefore sit behind a function layer:

1. New schemas `social`, `home` and `notify`. **`n8n_worker` gets no table privileges on them** (the default
   privileges of migration 0003 apply to schema `app` and others, not to these).
2. A role `app_rls`: `NOLOGIN`, **no `BYPASSRLS`**, with the table privileges the functions need.
3. Every read and write is a function `SECURITY DEFINER` owned by `app_rls`, with a fixed `search_path`. Its first
   statement is `set_config('app.user_id', p_user::text, true)`. The tables have RLS enabled and forced, and their
   policies use `app.current_user_id()` (exists). So inside the function, PostgreSQL itself filters the rows.
4. `n8n_worker` gets `EXECUTE` on those functions only. `p_user` always comes from the gateway context, never from
   the request body.
5. Membership checks inside policies go through `SECURITY DEFINER` helpers (`home.my_households()`,
   `social.my_conversations()`) to avoid policies that query their own table.

pgTAP tests prove it: as `n8n_worker`, `select * from home.expenses` is refused; a function called for user A on
household B returns nothing; a removed member loses access at once. Scheduled workflows that act for nobody (daily
reminders) call dedicated functions that return only what the notification needs.

### 7.2 Tables

Money is in minor units with a `currency` (exponent from `app.currencies` **E**). Times are `timestamptz`; dates
that belong to a household use its `timezone`. Every table has `created_at`; tables users change have `updated_at`.

**Schema `social`**

| Table | Main columns | Notes |
|---|---|---|
| `flatmate_profiles` | `user_id` pk, `visible` bool, `headline` (≤ 80), `bio` (≤ 600), `seeking` (room, flatmate, both), `areas` (place ids), `move_in_from` | Lifestyle and budget are read from `app.profiles` (one source). `bio` is never read by matching. |
| `favourites` | (`user_id`, `listing_id`) pk | |
| `saved_searches` | `id`, `user_id`, `name`, `params` jsonb (validated as `/v2/search` params), `alert` (none, daily), `last_alert_at`, `last_seen_published_at` | |
| `conversations` | `id`, `kind` (listing, application, household, direct), `listing_id`, `application_id`, `household_id`, `created_by`, `last_message_at` | |
| `conversation_members` | (`conversation_id`, `user_id`) pk, `last_read_at`, `left_at` | |
| `messages` | `id` bigint, `conversation_id`, `sender_id`, `body` (≤ 4,000), `flags` jsonb (scam warning codes), `hidden_by_moderation` bool, `deleted_at` | A member can delete their own message (blanked, row kept for reports). |
| `blocks` | (`blocker_id`, `blocked_id`) pk | A block stops new conversations and messages both ways and hides flatmate profiles. |
| `visit_slots` | `id`, `listing_id`, `starts_at`, `ends_at`, `capacity` | |
| `visits` | `id`, `listing_id`, `seeker_id`, `owner_id`, `slot_id`, `starts_at`, `status` (requested, proposed, confirmed, declined, cancelled, done, no_show), `note` | |
| `visit_events` | `visit_id`, `actor_id`, `action`, `starts_at`, `at` | History of proposals and decisions. |
| `applications` | `id`, `listing_id`, `applicant_id`, `owner_id`, `status` (submitted, accepted, declined, withdrawn, expired), `message`, `move_in_from`, `shared_profile` jsonb (lifestyle fields only, copied when the applicant chooses to share), `decided_at`, `decision_code` | One open application per applicant and listing (unique partial index). |

**Schema `home`**

| Table | Main columns | Notes |
|---|---|---|
| `households` | `id`, `name`, `jurisdiction_code`, `currency`, `timezone`, `listing_id` (optional), `address_text` (members only), `status` (active, closed), `created_by` | |
| `household_members` | (`household_id`, `user_id`) pk, `role` (flatmate, owner), `status` (active, leaving, left), `joined_at`, `move_in_on`, `move_out_on` | `owner` = the landlord or main tenant, with the limited view of 7.3. |
| `household_invites` | `id`, `household_id`, `code_hash`, `role`, `expires_at`, `used_by`, `used_at`, `created_by` | Code shown once; only its hash is stored. |
| `expenses` | `id`, `household_id`, `paid_by`, `amount_minor`, `currency`, `category` (rent, utilities, internet, groceries, household, other), `label`, `spent_on`, `split_mode` (equal, shares, exact), `created_by`, `deleted_at` | Soft delete by the creator, in the audit log. |
| `expense_shares` | (`expense_id`, `user_id`) pk, `share_minor` | Written by the same function as the expense; the sum always equals the amount. Equal split: each gets the integer part, and the leftover minor units go one by one to members in join order. |
| `settlements` | `id`, `household_id`, `from_user`, `to_user`, `amount_minor`, `settled_on`, `confirmed_at` (by the receiver) | A record that someone paid someone, nothing more. |
| `recurring_items` | `id`, `household_id`, `kind` (rent, bill), `label`, `amount_minor` (nullable), `due_day` (1 to 28), `remind_days_before`, `active` | |
| `rent_payments` | `id`, `household_id`, `user_id`, `period` (month), `amount_minor`, `paid_on`, `confirmed_by`, `confirmed_at` | Receipts only for confirmed rows. |
| `chores` | `id`, `household_id`, `title`, `frequency` (daily, weekly, every two weeks, monthly), `rotation` uuid[], `next_due_on`, `active` | |
| `chore_assignments` | `id`, `chore_id`, `user_id`, `due_on`, `done_at`, `done_by` | Made by the daily workflow, next person in `rotation`. |
| `shopping_items` | `id`, `household_id`, `label`, `quantity`, `added_by`, `done_at`, `done_by` | |
| `house_rules` | `id`, `household_id`, `position`, `category`, `text`, `updated_by` | |
| `events` | `id`, `household_id`, `title`, `starts_at`, `ends_at`, `all_day`, `created_by` | Calendar view also merges due dates, chores, visits, move dates (computed, not copied). |
| `announcements` | `id`, `household_id`, `author_id`, `body`, `pinned` | |
| `issues` | `id`, `household_id`, `reported_by`, `title`, `description`, `category`, `urgency` (low, normal, urgent), `status` (open, acknowledged, in_progress, resolved, closed), `media_ids` uuid[] | |
| `issue_events` | `issue_id`, `actor_id`, `status`, `comment`, `at` | |
| `documents` | `id`, `household_id`, `kind` (flatmate_agreement, inventory_entry, inventory_exit, rent_receipt, house_rules), `jurisdiction_code`, `language`, `template_key`, `template_version`, `inputs` jsonb, `sources` jsonb (URL, title, retrieved date), `notice_version`, `status` (queued, ready, failed), `storage_key`, `created_by` | |
| `inventory_items` | `id`, `document_id`, `room`, `item`, `condition` (new, good, worn, damaged, missing), `note`, `media_ids` | Exit compared with entry by room and item. |
| `move_outs` | `id`, `household_id`, `user_id`, `notice_given_on`, `leave_on`, `checklist` jsonb (item key, done, source), `status` | |
| `deposits` | `id`, `household_id`, `user_id`, `amount_minor`, `paid_on`, `held_by` (owner, flatmate, other), `returned_minor`, `deductions` jsonb (code, amount, note), `returned_on`, `status` (held, partly_returned, returned, disputed) | |

**Schema `notify`**

| Table | Main columns |
|---|---|
| `notifications` | `id`, `user_id`, `type` (code), `params` jsonb, `link_kind`, `link_id`, `read_at` |
| `preferences` | (`user_id`, `type`) pk, `in_app`, `email`, `telegram` |
| `deliveries` | `id`, `notification_id`, `channel`, `status`, `attempts`, `error_code`, `sent_at` |

**Other new or changed tables**

| Table | Change |
|---|---|
| `app.reports` | new columns `target_type` (listing, user, message), `target_user_id`, `message_id`, `status`, `queue_id`; existing rows keep `target_type = listing` |
| `app.price_benchmarks` | per jurisdiction, city, neighbourhood: median and spread of monthly rent, count, computed at |
| `app.user_badges` | `user_id`, `badge`, `verified_at`, `method` |
| `kb.templates` | `key`, `jurisdiction_code`, `kind`, `language`, `version`, `body` (HTML with named slots), `slots` jsonb, `sources` jsonb, `official_translation` bool |
| `kb.guides` | `key`, `jurisdiction_code`, `language`, `title`, `sections` jsonb, each section with its `source_ids` |
| `ai.document_drafts` | like `ai.listing_changes`: proposed slot values, expiry, status |

### 7.3 Who sees what

| Data | Flatmate member | Owner member | Other users |
|---|---|---|---|
| Members, announcements, house rules, calendar, issues, documents, rent payments | yes | yes | no (404) |
| Expenses, balances, settlements, chores, shopping list | yes | no | no |
| Deposit row | own row | rows of the household | no |
| Conversation and its messages | members of the conversation | same | no |
| Application | applicant and the listing's owner | | no |
| Flatmate profile | visible ones, minus blocked users | | |

### 7.4 Retention and erasure

`DELETE /v1/me` (P10) extends `app.erase_user`: messages blanked, flatmate profile and favourites deleted, household
membership set to `left` with the name replaced, documents the user generated deleted from storage. Records other
members depend on (an expense the user paid) keep the amount with an anonymous member, so balances stay right. The
retention periods for messages and closed households are a policy choice for Firas (spec 13.5), stored as settings.

---

## 8. API conventions for the new endpoints

- Same envelope, headers, signing, idempotency, error codes and job pattern as `/v1` today. No new top-level error
  code: specific reasons go in `details` (`{"issue": "blocked"}`, `{"issue": "balance_not_settled"}`), because the
  `ErrorCode` enum belongs to existing operations.
- Lists use `cursor` and `limit` (1 to 50, default 20); the next cursor is in `meta`.
- Every state change records an audit row when it matters to a dispute (decisions, deletions, confirmations).
- Rate limits: the existing per-user limit, plus a stricter one on `POST .../messages` and `POST /v1/reports`
  (settings), against spam.
- `n8n/build.py` generates the Caddy rewrites for parameterised routes into `infra/caddy/routes.caddy`, imported by
  the Caddyfile, and the existing workflow test checks both lists agree.
- Each new operation gets a contract test file section with at least: unsigned or tampered request (401), missing
  consent (403), wrong role where a role is required (403), another user's resource (404), invalid body (422 with
  details), idempotent replay (same response) and key reuse with another body (409), and the success path. A
  separate `tests/contract/test_isolation.py` runs every household, conversation and application operation as a
  non-member.
- Response fixtures: contract tests save real responses of the sandbox stack (synthetic data) into
  `tests/fixtures/api/<operationId>/<case>.json` when run with `--record-fixtures`; a unit test validates every
  fixture against `openapi.yaml`. The website can run on them with `FLATSHARE_API_MODE=fixtures`.

---

## 9. Phases, definitions of done and tests

Each phase ends the same way: tests run and pasted in `TEST_REPORT.md` (T-xx), DECISIONS and FAILURES updated,
ARCHITECTURE and `openapi.yaml` updated, then I stop, give one commit command, and wait for approval. "Measured on
the PC" means Firas runs a script and the numbers come from that run.

### Demo-ready core: P1 to P5

**P1 Foundations and accounts**

- Front-end readiness (spec 17.1): response fixtures and their schema test; storage CORS in Caddy for signed PUT
  uploads and signed GET media from the website origin (`WEB_ORIGIN`); BFF environment variables documented in
  `.env.example` and RUNBOOK (`FLATSHARE_API_BASE`, `FLATSHARE_WEBSITE_KEY_ID`, `FLATSHARE_WEBSITE_SECRET`,
  `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL`, `AUTH_DATABASE_URL`, `SMTP_*`, `PUBLIC_MEDIA_ORIGIN`, `WEB_ORIGIN`); the
  TypeScript signing helper.
- Row-level layer of 7.1: schemas, `app_rls`, helpers, one first table (`notify.notifications`) to prove the pattern.
- Caddy route generation from `build.py`.
- Website skeleton: Next.js, Better Auth with the `auth` database, Mailpit, next-intl with fr, en, ar and RTL,
  layout and navigation, error-code catalogue.
- Pages: sign-up, log in, e-mail check, reset, consent (with the 18+ statement of spec 13.7), lifestyle profile.
- Endpoints: `GET /v1/me`, `GET /v1/profiles/me`; also `GET /v1/me/notifications` and `POST /v1/me/notifications/read`
  (moved here from P4, D-096).
- **Done when:** a new person signs up in each language, confirms the e-mail in Mailpit, accepts consent, saves
  the lifestyle profile and finds it again after logging out and in; the Arabic pages are mirrored; no page scrolls
  sideways at 360 px; the browser bundle contains no secret.
- **Tests:** Vitest: the four vectors of `tests/vectors/signing.json` give the same canonical strings and signatures;
  contract tests for the two endpoints; pgTAP for the RLS layer (n8n_worker refused on the table, user A cannot read
  user B's notification through the functions); fixture schema test; a CORS preflight test (curl) and a real upload
  from a Chromium page on the website origin to a presigned URL (Playwright); Playwright sign-up to profile in three
  languages at desktop and 360 px; axe-core on these pages with no serious violation; the secret scan run over
  `web/.next`.

**P2 Search, listing page, favourites, assistant**

- `GET /v2/search`, `GET /v1/listings/{id}/public` with signed photo URLs (Caddy GET route under `media/` only),
  favourites, map with the PMTiles extract, the assistant page (result cards, legal answers with numbered sources
  and the notice, owner proposals with Confirm and Cancel), `POST /v1/listing-changes/{id}/cancel`.
- **Done when:** a user searches with filters and on the map, opens a listing with its photos, saves favourites,
  and chats with the assistant in each language; `/v1/search` answers exactly as before.
- **Tests:** contract tests for each new operation; a test that no search, listing or map response contains the
  exact location; a signed photo URL works before expiry and fails after; `/v1` search contract tests unchanged and
  passing; Playwright flows; `/v2/search` latency over 200 requests measured on the PC next to T-38's `/v1` figure;
  size of the map extract recorded.

**P3 Owners**

- The posting wizard (create, browser upload, analysis job with progress, review of the extracted fields and
  issues, corrections with PATCH), `POST /v1/listings/{id}/submit` (field check, then published; trust from P8),
  `GET /v1/me/listings`, archive and republish, the owner assistant panel.
- **Done when:** an owner posts a listing with three photos from a phone-sized browser, fixes a missing rent,
  publishes, finds it in search, then archives it.
- **Tests:** contract tests for submit (missing fields: 422 with codes; another owner's listing: 404; repeated
  submit: same answer) and my listings; a test that a second analysis does not overwrite a field the owner changed
  (the open point of D-077); Playwright posting flow at 360 px.

**P4 Contact, visits, applications, in-app notifications**

- Conversations and messages, blocks, visit slots and visit requests, applications with accept and decline,
  `POST /v1/reports` (stored and queued; the moderation pages come in P8), `wf.notify.emit` and the notifications
  endpoints.
- **Done when:** a seeker writes to an owner about a listing, they agree a visit in one of the owner's slots, the
  seeker applies and the owner accepts; each step creates a notification for the other side; a blocked user cannot
  write; a third user sees none of it.
- **Tests:** pgTAP per table for the policies of 7.3; contract tests with the isolation file; message rate limit;
  idempotent send; a two-browser Playwright test (seeker and owner side by side).

**P5 Household core and expenses** (end of the demo-ready core)

- Households, invites by code, join, members, overview; application accepted → invite; expenses with the three
  split modes and preview, balances, suggested settlements, settlements; recurring rent and bills with the daily
  reminder workflow; rent payments with owner confirmation; announcements.
- **Done when:** the demo script runs end to end: two flatmates and an owner, three expenses with different splits,
  balances shown, one settlement recorded, a rent reminder notification on the right day.
- **Tests:** pgTAP: split sums always equal the amount (every split mode, amounts that do not divide evenly, 2 to 6
  members); balances on a fixed scenario whose expected values are written by hand in the test; suggested
  settlements reduce every balance to zero; a member who left keeps access to nothing; contract and isolation tests;
  the reminder workflow run against a fixed "today" (a setting used only by tests).

After P5: a demo rehearsal checklist and a TEST_REPORT summary of the core.

### After the core

**P6 Household life:** chores rota (assignments by the daily workflow), shopping list, house rules, calendar (own
events plus due dates, chores, visits, move dates), repairs and issues with photos, status updates and notifications
to the owner member. *Done when* a full week of the demo household can be shown. *Tests:* rotation order over
several cycles, a member leaving the rotation, issue photo goes through blur and EXIF removal, owner member sees
issues but not expenses, isolation tests.

**P7 Flatmates:** flatmate profiles, browse with compatibility, room-free posts from a household, saved searches
and daily alerts. *Done when* a seeker finds a household's room post and a compatible flatmate, and an alert arrives
for a new matching listing. *Tests:* compatibility is unchanged when any non-lifestyle field changes (name, locale,
language of the bio, bio text): an invariance test over all user columns; unknown answers are never counted as
mismatches; blocked users never appear; the alert workflow sends each listing once.

**P8 Trust and safety (backend spec phase 5):** price benchmark, phrase lists per pack, Trust agent A4 with
`P4_trust_assessor`, submit → trust job → published, review or blocked; moderation queue and decisions with the
audit log; report triage; scam warnings in messages and on listing pages; badges. *Done when* a scam-like listing
goes to review with its evidence, a moderator decides, and the decision is in the audit log. *Tests:* a labelled
trust set (synthetic, labels written before running, composition documented), precision of `block` and false-block
rate on honest listings measured on the PC against the spec 2.6 targets; no `block` without a hard signal (code
test); injected text in a listing does not change the verdict (adversarial items in the set); agent benchmark
script and trace step.

**P9 Documents and legal (backend spec phases 6 and 7, documents part):** for TN first, then FR and GB: find and
fetch the primary sources for each document type, write the templates with their slots and sources, PDF rendering
(the Arabic test of 6.7 first), document endpoints and pages, Document agent A6 behind the `generate_document`
intent, rent receipts, entry inventory; `POST /v1/legal/ask`; guides on deposits, notice and scams; FR and GB
knowledge packs. *Done when* the demo household gets a flatmate agreement, an entry inventory and a rent receipt in
its country and language, each showing its sources and the notice. *Tests:* every template slot is filled or the
document is refused with the missing slots listed; no text outside the template appears in a PDF (diff test against
the template); the agent's proposals are checked against the slot list (a value for an unknown slot is dropped); a
document agent set (labelled conversations) measured on the PC; `POST /v1/legal/ask` gives the same checks as the
assistant path (T-60 set re-run through it).

Routing `generate_document` to the new agent changes what `POST /v1/assistant/message` answers for that intent
(today "not available yet") and adds an optional `document_proposal` field. D-087 and D-088 did the same for the
Legal agent and the owner assistant, and the operation's description says those intents answer "not available yet"
until their agents exist. P9 follows that precedent unless Firas prefers a `/v2/assistant/message`.

**P10 Moving out and privacy (backend spec phase 7, privacy part):** notice checklist from sourced pack data, exit
inventory and comparison, deposit tracking, leaving the household, `DELETE /v1/me` and the retention workflow for
the new data. *Done when* a flatmate leaves the demo household with the checklist done, the deposit recorded and the
balance settled, and a deleted account leaves no personal data in the database or storage. *Tests:* erasure checked
table by table and object by object (spec 13.6), balances still sum to zero after a member's erasure, retention run
with fixed dates.

**P11 Notification channels and admin:** e-mail (SMTP, Mailpit in development) and Telegram delivery with
preferences, Telegram linking by code; admin pages for moderation, traces, knowledge base, evaluation runs, prompts,
settings and staff roles. *Done when* a notification reaches the in-app list, Mailpit and Telegram according to the
preferences, and an admin can run an ingestion and read a trace from the website. *Tests:* delivery retries and
failure codes; a user cannot change another user's preferences; admin endpoints refuse non-admins; settings outside
the allowlist refused.

**P12 Evaluation and hardening (backend spec phases 8 and 9):** remaining spec 8 items (full ablation matrix,
single-agent comparison where cheap, prompt library and evaluation documents generated from data); a security pass
(the isolation matrix over every endpoint, CSRF and origin checks on the website server, stored text shown without
HTML injection, upload limits); load test on search and messages measured on the PC; backup and restore tested;
accessibility pass; README run from a clean machine. *Done when* spec section 15 items are recorded and the demo
runs from a clean start.

---

## 10. Risks and points to decide later

| Risk or open point | Effect | What the plan does |
|---|---|---|
| Everything runs on one PC (Ollama half on CPU, n8n, PostgreSQL, Garage, now Next.js) | Slow pages during model calls | Agents only where they help; no model on household or message paths; RAM and CPU use of the website not measured yet (P1 records `docker stats`) |
| About 90 new operations | Time; each needs its workflow, SQL function, contract tests | Ordered so the demo core (P1 to P5) is complete first; shared builder functions in `build.py` |
| Primary sources for templates may not exist for every country and document type | A document type missing for a country | The page says "not available for this country"; nothing is written without a source |
| WeasyPrint and Arabic | Broken Arabic PDFs | Tested first in P9; Gotenberg fallback |
| Users will ask for gender-restricted flatshares | Requests refused | Platform rule from Firas: never on protected traits; the refusal message explains it (owner assistant already does, D-089) |
| A person who used the Telegram bot and then signs up on the website gets two platform users | Split history | Linking by code in P11 sets `telegram_chat_id` for notifications; merging two existing accounts is decided in P11 (D-xxx) |
| Retention periods for messages and closed households | Needed before real users | A policy choice for Firas (spec 13.5); settings ready, values not invented |
| Real e-mail sending | Needs an SMTP account | Only Firas can provide it; Mailpit covers the demo, so not blocking |
| `P5b_stance_extractor` and `P8_verifier` of the backend spec | Not built | Not planned; reconsidered if P12's evaluation shows wrong conflicts or unsupported claims |
| Anonymous visitors | Cannot search without an account | Search needs an account and consent, as on Telegram. A public read-only search would be `/v2/search` without a user; decided after the core if wanted |

---

## 11. Sources

Checked on 2026-10-16 for the stack choices in section 6.

- Next.js blog, release posts up to 16.4 (2026-10-06) and the security update of 2026-10-14: https://nextjs.org/blog
- Better Auth, "Auth.js is now part of Better Auth" (2025-09-22): https://www.better-auth.com/blog/authjs-joins-better-auth
- Better Auth, "Better Auth joins Vercel" (2026-07-07): https://better-auth.com/blog/better-auth-joins-vercel
- shadcn/ui changelog, "January 2026 - RTL Support": https://ui.shadcn.com/docs/changelog/2026-01-rtl
- Supabase, self-hosting maps with Protomaps (pmtiles extract and MapLibre): https://supabase.com/blog/self-host-maps-storage-protomaps
- Garage S3 compatibility reference: https://git.deuxfleurs.fr/Deuxfleurs/garage/src/commit/9975011a92b6571030b345378d035809f7ba1015/doc/book/reference-manual/s3-compatibility.md

Project sources: `FLATSHARE_BACKEND_SPEC.md` (2026-09-29), `docs/` and `db/migrations/` at commit 3cdafbe3.
