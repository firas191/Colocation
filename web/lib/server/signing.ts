// FS1-HMAC-SHA256 request signing (docs/API_SIGNING.md). The TypeScript twin of tests/client/fsclient.py and
// n8n/src/lib/canonical.js; checked against tests/vectors/signing.json (web/tests/signing.test.ts).
// Pure functions: no environment, no I/O, so the tests run without a server.
import { createHash, createHmac } from "node:crypto";

export type QueryValue = string | number | boolean;
export type QueryPairs = Array<[string, QueryValue]>;

/** Query parameters as ordered pairs; repeated keys keep their order. Objects are turned into pairs. */
export function toPairs(query?: QueryPairs | Record<string, QueryValue | QueryValue[] | undefined | null>): QueryPairs {
  if (!query) return [];
  if (Array.isArray(query)) return query;
  const out: QueryPairs = [];
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined || v === null) continue;
    for (const x of Array.isArray(v) ? v : [v]) out.push([k, x]);
  }
  return out;
}

/** encodeURIComponent per key and value, stable sort by encoded key, joined with "&". */
export function canonicalQuery(pairs: QueryPairs): string {
  const enc = pairs.map(([k, v]) => [encodeURIComponent(k), encodeURIComponent(String(v))] as const);
  // Array.prototype.sort is stable (ES2019): repeated keys keep their order.
  enc.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return enc.map(([k, v]) => `${k}=${v}`).join("&");
}

export function sha256Hex(body: Uint8Array | string): string {
  return createHash("sha256").update(body).digest("hex");
}

export interface CanonicalInput {
  timestamp: string;
  method: string;
  path: string;
  query: string;
  requestId: string;
  userId?: string;
  idempotencyKey?: string;
  clientIp?: string;
  body: Uint8Array | string;
}

export function canonicalString(x: CanonicalInput): string {
  return [
    "FS1-HMAC-SHA256", x.timestamp, x.method.toUpperCase(), x.path, x.query, x.requestId,
    x.userId || "", x.idempotencyKey || "", x.clientIp || "", sha256Hex(x.body),
  ].join("\n");
}

/** Lowercase hex HMAC-SHA256; the key is the UTF-8 bytes of the secret as issued (fss_...). */
export function sign(secret: string, canonical: string): string {
  return createHmac("sha256", Buffer.from(secret, "utf8")).update(Buffer.from(canonical, "utf8")).digest("hex");
}

/** Path parameters are percent-encoded like query values. */
export function pathWith(template: string, params: Record<string, string> = {}): string {
  return template.replace(/\{(\w+)\}/g, (_, k: string) => encodeURIComponent(params[k] ?? ""));
}
