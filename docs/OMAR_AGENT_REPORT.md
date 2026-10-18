# A4 — Omar's Rent Negotiator AI

## Overview

Omar's Rent Negotiator is an independent component of the Colocation platform that helps a renter prepare a monthly rent offer for a published property listing. It uses an AI model to draft a proposed amount and a short explanation, then requires explicit decisions from the renter and the verified listing owner. The agent supports at most two negotiation rounds. It does not send messages to a landlord or create a rental contract.

## Objective and scope

The agent's purpose is to make rent discussions more structured and transparent while keeping financial decisions under human control. It starts from the asking rent recorded on the actual listing and a target and maximum budget supplied by the renter. It produces a draft offer for review. If the renter approves that exact offer, the verified owner can accept, reject, or counter it. A first counteroffer opens a second and final round. A second counteroffer ends the automated path as unresolved and requires manual follow-up.

The initial version handles the **monthly rent amount only**. It does not negotiate a deposit, fees, prepayments, property conditions, legal terms, or a move-in date. An accepted offer is labelled a *tentative agreement* until the parties verify the details and sign rental terms.

## How the agent works

1. **Create a session.** The renter selects a published, nonsynthetic listing and enters a target and maximum budget. The platform links the session to the authenticated renter and the verified listing owner. It takes the asking rent and currency from the listing database rather than trusting a submitted property price.
2. **Draft round 1.** The workflow sends only the amounts, currency, and round number to the APInex chat model. The model returns a proposed amount and a brief French rationale. Deterministic checks reject invalid JSON, noninteger amounts, or amounts above the authorized budget or asking rent. If the model fails, the system uses a bounded deterministic draft and marks `model_used: false`.
3. **Renter decision.** The renter approves or rejects one specific amount, currency, round, negotiation ID, and record version. Rejection ends that path. Approval makes the offer eligible for an owner decision; it does not send an external message automatically.
4. **Owner decision.** The authenticated, verified listing owner may accept, reject, or submit a counteroffer. Acceptance produces a tentative agreement. Rejection ends the path. A first counteroffer starts round 2.
5. **Draft round 2 and finish.** The AI may draft a second offer, capped by the renter's maximum, the original asking rent, and the owner's counteroffer. The renter must approve this new amount separately. If the owner counters again, the status becomes `unresolved`; the agent cannot start round 3.

## Architecture

The implementation follows the platform's existing signed gateway architecture. Four n8n workflows provide negotiation creation, status retrieval, renter decisions, and owner decisions. The workflow graphs are maintained in `n8n/build.py`; their JavaScript logic lives in `n8n/src/nodes/` and shared validation logic in `n8n/src/lib/`. Generated workflow JSON is imported by the existing `n8n-setup` process.

PostgreSQL is the authoritative source of negotiation state. `app.negotiations` stores participants, listing, amounts, round, status, and version. `app.negotiation_events` records each proposal and decision with its actor, amount, currency, timestamp, and audit metadata. Database row locking and version checks prevent concurrent, stale, or duplicate decisions from changing the same offer. Amounts use integer minor units; in Tunisian dinars, **1 TND = 1,000 millimes**.

APInex is configured as an OpenAI-compatible n8n Chat Model for this component only. Its API key is kept outside source control and imported as an encrypted n8n credential. The existing Ollama workflows and A3 Match Agent are separate. Cloud processing requires the platform's `cloud_llm_processing` consent before a request can send user-derived amounts to APInex.

## Safety and authorization

- The AI drafts proposals; PostgreSQL enforces the maximum budget, permitted transitions, and two-round limit.
- Only the authenticated renter can approve or reject their draft. Only the verified listing owner can record an owner decision.
- Every decision identifies the exact offer amount, currency, round, and current record version.
- The complete database event history is authoritative. The model has no tool for contacting a landlord and no conversational memory that can override recorded decisions.
- The original prototype's n8n Wait forms are demonstration controls, not proof of renter or landlord identity. The integrated API uses signed requests and database participant checks.
- A status of `tentative_agreement` is not a signed lease or a claim that all rental terms have been agreed.

## Implementation and validation status

The workflow build check and 93 n8n JavaScript tests passed. All 16 focused PostgreSQL pgTAP checks passed. A signed localhost demonstration using the fictional test users and listing completed two negotiation rounds and reached `tentative_agreement`. PostgreSQL recorded seven events. Both agent proposals had `model_used: true`, and the final offer of 480,000 TND minor units stayed within the 500,000 budget and the owner's 480,000 counter. The local feature flag was set to false and the four A4 webhooks were unpublished after testing. Telegram `/negocier` and natural-language router integration are future work.

## Short conclusion

The A4 component turns rent negotiation into a traceable, two-round process: AI prepares bounded drafts, people make the decisions, and PostgreSQL records what actually happened. It remains disabled by default.
