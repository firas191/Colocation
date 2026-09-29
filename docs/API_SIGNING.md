# Request signing (FS1-HMAC-SHA256)

Every call to `/v1/*` is made by a server (the website's backend, a test client), never by a
browser. The server holds a key id and a secret issued by `scripts/db-bootstrap.sh`
(written to `secrets/api-clients.env`, never printed) and signs each request.

## Headers

| Header | Required | Content |
|---|---|---|
| `X-Key-Id` | yes | key id, e.g. `website` |
| `X-Timestamp` | yes | Unix time in seconds; accepted within ±300 s of the server clock |
| `X-Request-Id` | yes | new UUID per request; each value is accepted once per key |
| `X-Signature` | yes | lowercase hex HMAC-SHA256, 64 characters |
| `X-User-Id` | when acting for a user | platform user id (UUID) |
| `X-Idempotency-Key` | on state-changing calls | 8 to 128 characters from `A-Z a-z 0-9 _ . : -` |
| `X-Client-Ip` | recommended | the end user's IP as the website server saw it; used for per-IP rate limits |
| `Content-Type` | with a body | `application/json` |
| `Accept-Language` | optional | BCP-47 |

## Canonical string

Ten lines joined by `\n` (no trailing newline). Absent optional values are empty lines.

```
FS1-HMAC-SHA256
<X-Timestamp>
<HTTP method, upper case>
<path, e.g. /v1/users/sync, without query>
<canonical query>
<X-Request-Id>
<X-User-Id or empty>
<X-Idempotency-Key or empty>
<X-Client-Ip or empty>
<lowercase hex SHA-256 of the raw body bytes; for no body, the hash of zero bytes>
```

**Canonical query.** For each parameter value: `encodeURIComponent(key) + "=" + encodeURIComponent(value)`
(JavaScript semantics: `A-Z a-z 0-9 - _ . ! ~ * ' ( )` stay as they are, everything else is
UTF-8 percent-encoded with upper-case hex). Sort the pairs by the encoded key with a stable
sort, so repeated keys keep their order. Join with `&`. Nested parameters such as `a[b]=1`
are refused.

**Path.** Path parameters are percent-encoded the same way (`encodeURIComponent`).

**Signature.** `hex(HMAC_SHA256(key = UTF-8 bytes of the secret string, message = UTF-8 bytes of the canonical string))`.
The secret is used as issued (`fss_` + 64 hex characters); do not decode it.

**Body.** Sign the exact bytes you send. Re-serialising JSON after signing (different spacing
or key order) breaks the signature (test `test_body_whitespace_is_signed_bytes`).

## What the server checks, in order

1. Per-IP rate limit (counts every request, including failed signatures).
2. Key exists and is active; timestamp within ±300 s; signature matches; request id not seen before.
   Any failure: `401 UNAUTHENTICATED`. A stale timestamp returns `details[0].server_time`.
3. Per-user rate limit: `429 RATE_LIMITED` with `Retry-After`.
4. `X-User-Id` refers to an existing, non-erased user (`401` / `403 FORBIDDEN`); role and consent
   rules of the route (`403 FORBIDDEN`, `403 CONSENT_REQUIRED`).
5. Body rules: JSON content type, JSON object (`422 VALIDATION_FAILED`).
6. Idempotency key present and valid on state-changing routes (`422`), then replay or conflict handling (`409 CONFLICT`).

## Implementations and test vectors

- Python reference client: `tests/client/fsclient.py`
- Server: canonicalisation in `n8n/src/lib/canonical.js` (Code node), HMAC and comparison in
  `sec.verify_request` (PostgreSQL, migration 0002)
- TypeScript helper for the website server: phase 9 deliverable

`tests/vectors/signing.json` holds four fixed requests with their canonical strings and
signatures (secret `fss_0123456789abcdef…`, published test value). The Python client
(`tests/unit/test_signing_vectors.py`), the JavaScript helpers (`n8n/tests/canonical.test.js`)
and PostgreSQL (`db/tests/030_gateway.sql`) all reproduce them.
