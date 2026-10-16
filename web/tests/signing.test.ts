// The website's signing helper reproduces the published test vectors (tests/vectors/signing.json), like the Python
// client, the n8n Code node helpers and PostgreSQL do (docs/API_SIGNING.md).
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { canonicalQuery, canonicalString, pathWith, sign, toPairs, type QueryPairs } from "@/lib/server/signing";

const vectors = JSON.parse(readFileSync(path.join(__dirname, "..", "..", "tests", "vectors", "signing.json"), "utf8"));

describe("FS1-HMAC-SHA256 test vectors", () => {
  for (const v of vectors.vectors) {
    it(v.name, () => {
      const q = canonicalQuery((v.query_params || []) as QueryPairs);
      expect(q).toBe(v.canonical_query);
      const canon = canonicalString({
        timestamp: v.timestamp, method: v.method, path: v.path, query: q, requestId: v.request_id, userId: v.user_id,
        idempotencyKey: v.idempotency_key, clientIp: v.client_ip, body: v.body_utf8,
      });
      expect(canon).toBe(v.canonical_string);
      expect(sign(vectors.secret, canon)).toBe(v.signature);
    });
  }
});

describe("helpers", () => {
  it("objects become ordered pairs; null and undefined are dropped", () => {
    expect(toPairs({ b: 2, a: ["x", "y"], c: undefined, d: null })).toEqual([["b", 2], ["a", "x"], ["a", "y"]]);
  });
  it("path parameters are percent-encoded", () => {
    expect(pathWith("/v1/listings/{id}", { id: "a b/c" })).toBe("/v1/listings/a%20b%2Fc");
  });
  it("a changed body changes the signature", () => {
    const base = { timestamp: "1", method: "POST", path: "/v1/x", query: "", requestId: "r", body: "{}" };
    expect(sign("s", canonicalString(base))).not.toBe(sign("s", canonicalString({ ...base, body: "{ }" })));
  });
});
