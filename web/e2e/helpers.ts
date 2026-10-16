import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { canonicalString, sign } from "../lib/server/signing";

const MAIL = process.env.E2E_MAIL_API || "http://localhost:8025";
export const BASE = process.env.E2E_BASE_URL || "http://localhost:3000";

/** The newest mail to an address (Mailpit API; the sandbox's mail_sink.py answers the same calls). */
export async function latestMailTo(address: string, subjectPart?: string, timeoutMs = 20_000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const list = await (await fetch(`${MAIL}/api/v1/messages`)).json();
    const m = list.messages.find((x: { To: Array<{ Address: string }>; Subject: string }) =>
      x.To.some((t) => t.Address.toLowerCase() === address.toLowerCase()) && (!subjectPart || x.Subject.includes(subjectPart)));
    if (m) return (await fetch(`${MAIL}/api/v1/message/${m.ID}`)).json() as Promise<{ Subject: string; Text: string }>;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`no mail to ${address}`);
}

/** The link in a mail, pointed at the website under test (the mail names BETTER_AUTH_URL). */
export function linkIn(text: string) {
  const m = text.match(/https?:\/\/\S+/);
  if (!m) throw new Error("no link in mail");
  const u = new URL(m[0]);
  const base = new URL(BASE);
  u.protocol = base.protocol; u.host = base.host;
  return u.toString();
}

export const uniqueEmail = (tag: string) => `e2e-${tag}-${randomUUID().slice(0, 8)}@example.test`;

/** No horizontal scrolling: the page is not wider than the window (checked at 360 px on the phone project). */
export async function expectNoSideScroll(page: Page) {
  const [scroll, client] = await page.evaluate(() => [document.documentElement.scrollWidth, document.documentElement.clientWidth]);
  expect(scroll, "page wider than the window").toBeLessThanOrEqual(client + 1);
}

/** No serious or critical accessibility violation (axe-core). */
export async function expectAccessible(page: Page) {
  const r = await new AxeBuilder({ page }).analyze();
  const bad = r.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
  expect(bad.map((v) => `${v.id}: ${v.nodes.slice(0, 3).map((n) => n.target.join(" ")).join(" | ")}`)).toEqual([]);
}

// ---- signed calls with the tests key, for arranging state (upload test) ---------------------------------------
function secrets() {
  const file = process.env.FS_SECRETS_FILE || "../secrets/api-clients.env";
  const out: Record<string, string> = {};
  for (const line of readFileSync(file, "utf8").split("\n")) { const i = line.indexOf("="); if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1).trim(); }
  return { keyId: out.FLATSHARE_TESTS_KEY_ID, secret: out.FLATSHARE_TESTS_SECRET };
}

export async function platform(method: string, path: string, body?: unknown, userId = "") {
  const { keyId, secret } = secrets();
  const raw = body === undefined ? "" : JSON.stringify(body);
  const requestId = randomUUID();
  const timestamp = String(Math.floor(Date.now() / 1000));
  const idem = method === "GET" ? "" : `e2e-${randomUUID()}`;
  const headers: Record<string, string> = { "X-Key-Id": keyId, "X-Timestamp": timestamp, "X-Request-Id": requestId,
    "X-Signature": sign(secret, canonicalString({ timestamp, method, path, query: "", requestId, userId, idempotencyKey: idem, body: raw })) };
  if (userId) headers["X-User-Id"] = userId;
  if (idem) headers["X-Idempotency-Key"] = idem;
  if (raw) headers["Content-Type"] = "application/json";
  const r = await fetch((process.env.E2E_API_BASE || "http://localhost:8080") + path, { method, headers, body: raw || undefined });
  return { status: r.status, json: await r.json() };
}
