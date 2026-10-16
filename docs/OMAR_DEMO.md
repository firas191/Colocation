# Omar A4 demonstration

Use the existing signed API client described in `docs/API_SIGNING.md`; browsers must not call the proxy directly. This walkthrough uses a published nonsynthetic apartment listing owned by a verified user. Both users accept the relevant consents. Use fresh request IDs and idempotency keys for every POST.

1. As the renter, create a negotiation with `POST /v1/negotiations` and body `{"listing_id":"<published-listing-uuid>","target_minor":450000,"max_minor":500000}`. For TND, this means 450.000 and 500.000 dinars. Read `negotiation_id`, `offer_minor`, `currency`, `round`, `version`, and `model_used`. `model_used:false` means a deterministic draft was used because the provider response was unavailable or invalid.
2. Review the draft. As that renter, send `POST /v1/negotiations/<id>/renter-decision` with `{"version":2,"action":"approve","offer_minor":450000,"currency":"TND","round":1}`, replacing the version and amount with the actual response. Rejection uses `"action":"reject"` and terminates the path.
3. As the verified listing owner, send `POST /v1/negotiations/<id>/landlord-decision` with the current version, `"action":"counter"`, `"offer_minor":480000`, `"currency":"TND"`, `"round":1`. The response contains a second draft, capped by 480.000 and the renter's 500.000 maximum. It has its own version and must be reviewed by the renter.
4. The renter approves the exact round 2 offer with its current version, amount and `"round":2`. The owner can then `accept` that same offer. A second `counter` yields `unresolved`; it cannot start round 3.
5. Call `GET /v1/negotiations/<id>` as either participant. Check `history` for creation, proposals and every human decision, with actor and timestamp. `tentative_agreement` means only a provisional rent understanding pending signed rental terms.

The HTTP signatures cover path, method, body, user ID and idempotency key. Use the signing test client or website server; copying these JSON examples into an unsigned `curl` command will return 401.
