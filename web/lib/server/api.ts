// The only way the website reaches the platform API (PLATFORM_SPEC 6.2). Runs on the server: the secret never
// reaches a browser ("server-only" makes the build fail if a client component imports this file).
import "server-only";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { canonicalQuery, canonicalString, sign, toPairs, type QueryPairs, type QueryValue } from "./signing";
import operations from "./operations.json";

export interface ApiError { code: string; message: string; details: Array<Record<string, unknown>> }
export type ApiResult<T> =
  | { ok: true; status: number; data: T; requestId: string }
  | { ok: false; status: number; error: ApiError; requestId: string | null };

export interface CallOptions {
  query?: QueryPairs | Record<string, QueryValue | QueryValue[] | undefined | null>;
  body?: unknown;
  userId?: string | null;
  /** Required by the API on state-changing calls. Pass the key the page generated for this submission so that a
   *  double click or a retry gives the stored answer instead of a second change. */
  idempotencyKey?: string;
  clientIp?: string | null;
  lang?: string;
  timeoutMs?: number;
}

function config() {
  const base = process.env.FLATSHARE_API_BASE;
  const keyId = process.env.FLATSHARE_WEBSITE_KEY_ID;
  const secret = process.env.FLATSHARE_WEBSITE_SECRET;
  if (!base || !keyId || !secret) throw new Error("FLATSHARE_API_BASE, FLATSHARE_WEBSITE_KEY_ID and FLATSHARE_WEBSITE_SECRET must be set");
  return { base: base.replace(/\/$/, ""), keyId, secret };
}

const UNAVAILABLE: ApiError = { code: "UPSTREAM_UNAVAILABLE", message: "The platform API could not be reached", details: [] };

export async function api<T = Record<string, unknown>>(method: string, path: string, o: CallOptions = {}): Promise<ApiResult<T>> {
  if (process.env.FLATSHARE_API_MODE === "fixtures") return fromFixture<T>(method, path);
  const { base, keyId, secret } = config();
  const pairs = toPairs(o.query);
  const q = canonicalQuery(pairs);
  const raw = o.body === undefined ? "" : JSON.stringify(o.body);
  const requestId = randomUUID();
  const timestamp = String(Math.floor(Date.now() / 1000));
  const headers: Record<string, string> = {
    "X-Key-Id": keyId, "X-Timestamp": timestamp, "X-Request-Id": requestId,
    "X-Signature": sign(secret, canonicalString({
      timestamp, method, path, query: q, requestId, userId: o.userId || "", idempotencyKey: o.idempotencyKey || "",
      clientIp: o.clientIp || "", body: raw,
    })),
    "Accept-Language": o.lang || "fr",
  };
  if (o.userId) headers["X-User-Id"] = o.userId;
  if (o.idempotencyKey) headers["X-Idempotency-Key"] = o.idempotencyKey;
  if (o.clientIp) headers["X-Client-Ip"] = o.clientIp;
  if (raw) headers["Content-Type"] = "application/json";
  let res: Response;
  try {
    res = await fetch(base + path + (q ? "?" + q : ""), {
      method, headers, body: raw || undefined, cache: "no-store", signal: AbortSignal.timeout(o.timeoutMs ?? 30_000),
    });
  } catch {
    return { ok: false, status: 503, error: UNAVAILABLE, requestId: null };
  }
  let json: { request_id?: string; data?: T; error?: ApiError } = {};
  try { json = await res.json(); } catch { /* the proxy always answers JSON; anything else is an outage */ }
  if (res.ok && json.data !== undefined) return { ok: true, status: res.status, data: json.data, requestId: json.request_id || requestId };
  return { ok: false, status: res.status, error: json.error || UNAVAILABLE, requestId: json.request_id || null };
}

// Fixture mode (FLATSHARE_API_MODE=fixtures): answers with the responses the contract tests recorded
// (tests/fixtures/api/<operationId>/<status>.json), so pages can be built without the stack.
async function fromFixture<T>(method: string, p: string): Promise<ApiResult<T>> {
  const op = (operations as Array<{ method: string; regex: string; id: string; success: number }>)
    .find((x) => x.method === method.toUpperCase() && new RegExp(x.regex).test(p));
  const dir = process.env.FLATSHARE_FIXTURES_DIR || path.join(process.cwd(), "..", "tests", "fixtures", "api");
  if (!op) return { ok: false, status: 404, error: { code: "NOT_FOUND", message: "No fixture", details: [] }, requestId: null };
  try {
    const j = JSON.parse(await readFile(path.join(dir, op.id, `${op.success}.json`), "utf8"));
    return { ok: true, status: op.success, data: j.data as T, requestId: j.request_id };
  } catch {
    return { ok: false, status: 404, error: { code: "NOT_FOUND", message: "No fixture", details: [] }, requestId: null };
  }
}
