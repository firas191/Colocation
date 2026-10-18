#!/usr/bin/env python3
"""Interactive, localhost-only A4 demo for Colocation Rent Negotiator.

Uses the repository's locally issued signed-API test client and Python stdlib.
Does not create users/listings, change feature flags, publish workflows, or
contact real landlords. Requires an existing published user listing, a renter,
and an authorized verified test owner with required consents.

Run from Colocation-Omar repository root:
  python omar_a4_local_demo.py --listing LISTING_UUID --renter RENTER_UUID --owner OWNER_UUID

This is an independent demonstration helper, not a deployment client.
"""
import argparse
import hashlib
import hmac
import json
import sys
import time
import uuid
from pathlib import Path
from urllib import error, request
from urllib.parse import urlparse


def read_properties(path):
    values = {}
    for raw in path.read_text(encoding="utf-8-sig").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        name, value = line.split("=", 1)
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]
        values[name.strip()] = value
    return values


def run_call(base, key_id, secret, method, path, user_id, body=None):
    req_id = str(uuid.uuid4())
    timestamp = str(int(time.time()))
    idem = str(uuid.uuid4()) if method == "POST" else ""
    raw = (json.dumps(body, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
           if body is not None else b"")
    canonical = "\n".join((
        "FS1-HMAC-SHA256", timestamp, method, path, "", req_id, user_id,
        idem, "", hashlib.sha256(raw).hexdigest(),
    ))
    signature = hmac.new(secret.encode("utf-8"), canonical.encode("utf-8"),
                         hashlib.sha256).hexdigest()
    headers = {
        "X-Key-Id": key_id,
        "X-Timestamp": timestamp,
        "X-Request-Id": req_id,
        "X-User-Id": user_id,
        "X-Signature": signature,
        "Accept-Language": "en",
        "Accept": "application/json",
    }
    if method == "POST":
        headers["X-Idempotency-Key"] = idem
        headers["Content-Type"] = "application/json"
    req = request.Request(base + path, method=method, data=raw if method == "POST" else None,
                          headers=headers)
    try:
        with request.urlopen(req, timeout=100) as response:
            status = response.status
            raw_response = response.read()
    except error.HTTPError as e:
        status = e.code
        raw_response = e.read()
    except Exception as e:
        raise RuntimeError(f"Unable to reach {base}{path}: {e}") from e
    try:
        payload = json.loads(raw_response.decode("utf-8"))
    except (ValueError, UnicodeDecodeError):
        payload = {"unparsed_body": raw_response[:1200].decode("utf-8", errors="replace")}
    print(f"\n{method} {path} => HTTP {status}")
    print(json.dumps(payload, ensure_ascii=False, indent=2))
    if not (200 <= status < 300):
        code = (payload.get("error") or {}).get("code", "UNKNOWN") if isinstance(payload, dict) else "UNKNOWN"
        raise RuntimeError(f"API returned HTTP {status} ({code}). See response above. No further decisions sent.")
    if not isinstance(payload, dict):
        raise RuntimeError("Expected a JSON object from the API.")
    return payload.get("data", payload)


def find_value(obj, key, depth=0):
    if depth > 5:
        return None
    if isinstance(obj, dict):
        if key in obj and obj[key] is not None:
            return obj[key]
        for sub in ("negotiation", "proposal", "draft", "state", "result", "data"):
            if sub in obj:
                found = find_value(obj[sub], key, depth + 1)
                if found is not None:
                    return found
    return None


def require(obj, *keys):
    values = {key: find_value(obj, key) for key in keys}
    missing = [k for k, v in values.items() if v is None]
    if missing:
        raise RuntimeError(
            "API succeeded but these fields are absent from the response: "
            + ", ".join(missing)
            + ". Inspect the JSON shown above and adjust the helper to match "
              "your local A4 version; nothing will be approved automatically."
        )
    return values


def confirm(word, question):
    got = input(f"\n{question}\nType {word} to proceed (anything else stops): ").strip()
    if got != word:
        print("Stopped. No further request sent; earlier saved events remain in the database.")
        sys.exit(0)


def state_after(call, negotiation_id, renter):
    return call("GET", f"/v1/negotiations/{negotiation_id}", renter)


def value_as_integer(value, label):
    if isinstance(value, bool):
        raise RuntimeError(f"Invalid boolean in {label}")
    try:
        n = int(value)
        if str(n) != str(value) and not (isinstance(value, float) and value.is_integer()):
            raise ValueError()
        return n
    except (ValueError, TypeError) as e:
        raise RuntimeError(f"Expected an integer in {label}, received {value!r}") from e


def main():
    ap = argparse.ArgumentParser(description="Interactive local A4 test. No external calling or messaging.")
    ap.add_argument("--listing", required=True, help="Published non-synthetic listing UUID")
    ap.add_argument("--renter", required=True, help="Renter's platform UUID")
    ap.add_argument("--owner", required=True, help="Verified, authorized listing owner's platform UUID")
    ap.add_argument("--base-url", default="http://127.0.0.1:18080")
    ap.add_argument("--target-minor", type=int, default=450000)
    ap.add_argument("--max-minor", type=int, default=500000)
    ap.add_argument("--counter-minor", type=int, default=480000)
    ap.add_argument("--secrets-file", default="secrets/api-clients.env")
    args = ap.parse_args()

    for label, val in (("listing", args.listing), ("renter", args.renter), ("owner", args.owner)):
        try:
            uuid.UUID(val)
        except ValueError as e:
            ap.error(f"--{label} must be a valid UUID: {e}")
    if args.renter == args.owner:
        ap.error("Renter and owner must be two distinct authorized test users")
    if not (0 < args.target_minor <= args.max_minor and args.counter_minor > 0):
        ap.error("Invalid target, budget, or counteroffer values")

    base = args.base_url.rstrip("/")
    parsed = urlparse(base)
    if parsed.scheme != "http" or parsed.hostname not in ("localhost", "127.0.0.1", "::1"):
        ap.error("This demo intentionally runs only against a local HTTP API. Remote/production endpoints are blocked.")

    f = Path(args.secrets_file)
    if not f.exists():
        ap.error("Missing secrets/api-clients.env. Check db-bootstrap logs and docs/API_SIGNING.md")
    creds = read_properties(f)
    key_id = creds.get("FLATSHARE_TESTS_KEY_ID", "")
    secret = creds.get("FLATSHARE_TESTS_SECRET", "")
    if not key_id or not secret:
        ap.error("Test signing credentials missing in secrets/api-clients.env; do not paste them into chat")

    print("=== Omar A4 Rent Negotiator | LOCAL INTERACTIVE DEMO ===")
    print("Uses existing two authorized test user identities. Never contacts a real landlord.")
    print("The signed test client acts on behalf of the indicated user: do NOT use this on production.")
    print(f"API: {base}\nListing: {args.listing}\nRenter: {args.renter}\nOwner: {args.owner}")
    print(f"Target: {args.target_minor} minor units | Maximum: {args.max_minor} | Counter: {args.counter_minor}")

    def call(method, path, user, body=None):
        return run_call(base, key_id, secret, method, path, user, body)

    confirm("START", "Confirm this is your localhost test database and you are authorized to act as both test users.")

    created = call("POST", "/v1/negotiations", args.renter, {
        "listing_id": args.listing,
        "target_minor": args.target_minor,
        "max_minor": args.max_minor,
    })
    got = require(created, "negotiation_id", "offer_minor", "currency", "round", "version")
    neg_id = str(got["negotiation_id"])
    offer = value_as_integer(got["offer_minor"], "offer_minor")
    currency = str(got["currency"])
    rnd = value_as_integer(got["round"], "round")
    version = value_as_integer(got["version"], "version")
    if rnd != 1:
        raise RuntimeError(f"Expected round 1 after create, saw {rnd}; no approval sent")
    if currency != "TND" or offer > args.max_minor or offer <= 0:
        raise RuntimeError("CRITICAL: invalid opening offer/currency. No approval sent.")
    print(f"\nROUND 1 OFFER: {offer} {currency} minor units; model_used={find_value(created, 'model_used')}")
    print("model_used=false indicates a deterministic fallback, not a verified APInex generation.")
    confirm("APPROVE", "After reviewing the exact AI proposal above: renter approves Round 1?")
    approved1 = call("POST", f"/v1/negotiations/{neg_id}/renter-decision", args.renter, {
        "version": version, "action": "approve", "offer_minor": offer,
        "currency": currency, "round": 1,
    })
    state1 = state_after(call, neg_id, args.renter)
    current1 = require(state1, "version")
    version1 = value_as_integer(current1["version"], "version")

    if args.counter_minor < offer:
        print("WARNING: the proposed landlord counteroffer is lower than the renter offer.")
        print("Check that this makes sense for the intended demonstration and the state machine.")
    confirm("COUNTER", f"As authorized simulated owner, submit Round 1 counteroffer of {args.counter_minor} minor units?")
    counter = call("POST", f"/v1/negotiations/{neg_id}/landlord-decision", args.owner, {
        "version": version1, "action": "counter", "offer_minor": args.counter_minor,
        "currency": currency, "round": 1,
    })
    state2 = state_after(call, neg_id, args.renter)
    # The landlord-decision endpoint should return the second draft; use its
    # exact version and offer. Fall back to the subsequent GET state if needed.
    # Never synthesize or guess approval data.
    second = counter if all(find_value(counter, k) is not None for k in ("offer_minor", "currency", "round", "version")) else state2
    got2 = require(second, "offer_minor", "currency", "round", "version")
    offer2 = value_as_integer(got2["offer_minor"], "offer_minor")
    currency2 = str(got2["currency"])
    rnd2 = value_as_integer(got2["round"], "round")
    version2 = value_as_integer(got2["version"], "version")
    if rnd2 != 2 or currency2 != currency:
        raise RuntimeError(f"Unexpected second round/currency ({rnd2} / {currency2}); no approval sent")
    if offer2 > args.max_minor or offer2 > args.counter_minor:
        raise RuntimeError("CRITICAL: second offer exceeds budget or landlord counter. No approval sent.")
    print(f"\nROUND 2 OFFER: {offer2} {currency2} minor units.")
    confirm("APPROVE", "After reviewing the exact second-round proposal: renter approves?")
    approved2 = call("POST", f"/v1/negotiations/{neg_id}/renter-decision", args.renter, {
        "version": version2, "action": "approve", "offer_minor": offer2,
        "currency": currency2, "round": 2,
    })
    state3 = state_after(call, neg_id, args.renter)
    version3 = value_as_integer(require(state3, "version")["version"], "version")
    confirm("ACCEPT", "As authorized simulated owner, accept the exact Round 2 renter offer provisionally?")
    accepted = call("POST", f"/v1/negotiations/{neg_id}/landlord-decision", args.owner, {
        "version": version3, "action": "accept", "offer_minor": offer2,
        "currency": currency2, "round": 2,
    })
    final = state_after(call, neg_id, args.renter)
    print("\n=== FINAL SAVED NEGOTIATION ===")
    print(json.dumps(final, ensure_ascii=False, indent=2))
    print(f"\nNegotiation ID: {neg_id}\nReview n8n workflow executions for more detail.")
    print("Any tentative agreement is a local simulation and does not create a lease.")


if __name__ == "__main__":
    try:
        main()
    except (RuntimeError, KeyboardInterrupt) as exc:
        print(f"\nSTOPPED: {exc}", file=sys.stderr)
        sys.exit(1)
