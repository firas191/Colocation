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

/** Photos nobody else has, drawn in the browser: random shapes on a random background, JPEG. The fixture room photos
 *  are used by every run and by other tests, so the trust check (D-107) rightly finds them on another owner's listing
 *  (duplicate_photo_other_owner) and sends the listing to review (T-79). */
export async function uniquePhotos(page: Page, n: number) {
  const data = await page.evaluate((count) => Array.from({ length: count }, () => {
    const c = document.createElement("canvas");
    c.width = 960; c.height = 720;
    const g = c.getContext("2d")!;
    const rnd = (k: number) => Math.floor(Math.random() * k);
    g.fillStyle = `rgb(${rnd(256)},${rnd(256)},${rnd(256)})`;
    g.fillRect(0, 0, c.width, c.height);
    for (let i = 0; i < 60; i++) {
      g.fillStyle = `rgb(${rnd(256)},${rnd(256)},${rnd(256)})`;
      if (i % 2) g.fillRect(rnd(c.width), rnd(c.height), 40 + rnd(300), 40 + rnd(300));
      else { g.beginPath(); g.arc(rnd(c.width), rnd(c.height), 20 + rnd(150), 0, Math.PI * 2); g.fill(); }
    }
    return c.toDataURL("image/jpeg", 0.9).split(",")[1];
  }), n);
  return data.map((b64, i) => ({ name: `room-${i + 1}.jpg`, mimeType: "image/jpeg", buffer: Buffer.from(b64, "base64") }));
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

// ---- platform P2: a member's session and a published listing with photos -------------------------------------------
export const PASSWORD = "correct-horse-battery"; // pragma: allowlist secret (test account)

/** Signs up a new person, confirms the address from the mail, accepts consent. Leaves the page on the profile. */
export async function signUpMember(page: Page, locale: "fr" | "en" | "ar", tag: string) {
  const email = uniqueEmail(tag);
  const button = { fr: "Créer le compte", en: "Create the account", ar: "إنشاء الحساب" }[locale];
  const mailWord = { fr: "Confirmez", en: "Confirm", ar: "أكّد" }[locale];
  const cont = { fr: "Continuer", en: "Continue", ar: "متابعة" }[locale];
  await page.goto(`/${locale}/signup`);
  await page.locator("#name").fill("Rim");
  await page.locator("#email").fill(email);
  await page.locator("#password").fill(PASSWORD);
  await page.getByRole("button", { name: button }).click();
  await page.waitForURL(/\/verify/);
  const mail = await latestMailTo(email, mailWord);
  await page.goto(linkIn(mail.Text));
  for (const id of ["#terms", "#privacy", "#adult"]) await page.locator(id).check();
  await page.getByRole("button", { name: cont }).click();
  await page.waitForURL(/\/profile/);
  return email;
}

/** A PUT of bytes to a presigned URL from Node. The URL names the public proxy; in a container the proxy has another
 *  name (E2E_API_BASE), so the request goes there with the signed Host header unchanged. */
async function putSigned(url: string, headers: Record<string, string>, body: Buffer) {
  const http = await import("node:http");
  const u = new URL(url);
  const base = new URL(process.env.E2E_API_BASE || "http://localhost:8080");
  return new Promise<number>((resolve, reject) => {
    const req = http.request({ host: base.hostname, port: base.port || 80, method: "PUT", path: u.pathname + u.search,
      headers: { ...headers, Host: u.host, "Content-Length": body.length } }, (res) => { res.resume(); resolve(res.statusCode || 0); });
    req.on("error", reject);
    req.end(body);
  });
}

/** The database, for what the API cannot do yet (publishing is P3's submit). E2E_DB_DSN: n8n_worker on the stack. */
async function db() {
  const { default: pg } = await import("pg");
  const c = new pg.Client({ connectionString: process.env.E2E_DB_DSN });
  await c.connect();
  return c;
}

/** A published listing in TN with two processed photos, through the normal path (presigned upload, analysis job).
 *  Its title carries a unique word so a search finds only it. */
export async function arrangePublishedListing(word: string) {
  const path = await import("node:path");
  const sync = await platform("POST", "/v1/users/sync", { external_auth_id: `e2e-owner-${randomUUID()}`, jurisdiction_code: "TN" });
  const owner = sync.json.data.user_id as string;
  await platform("POST", "/v1/me/consents", { consents: [{ purpose: "terms", granted: true }, { purpose: "privacy", granted: true },
    { purpose: "media_processing", granted: true }], policy_version: "e2e" }, owner);
  const lid = (await platform("POST", "/v1/listings", { text: `Chambre ${word}`, jurisdiction_code: "TN" }, owner)).json.data.listing_id as string;
  const files = [1, 2].map((i) => readFileSync(path.join(process.cwd(), "e2e", "fixtures", `room-${i}.jpg`)));
  const p = await platform("POST", `/v1/listings/${lid}/media/presign`, {
    files: files.map((f) => ({ kind: "photo", content_type: "image/jpeg", bytes: f.length })) }, owner);
  const ups = p.json.data.uploads as Array<{ url: string; headers: Record<string, string> }>;
  for (let i = 0; i < ups.length; i++) expect(await putSigned(ups[i].url, ups[i].headers, files[i])).toBe(200);
  const c = await db();
  const vision = (await c.query("select value from app.settings where key = 'vision.enabled'")).rows[0].value;
  await c.query("update app.settings set value = 'false' where key = 'vision.enabled'");     // photos only, no model call
  try {
    const job = await platform("POST", `/v1/listings/${lid}/analyze`, {}, owner);
    expect(job.status).toBe(202);
    const url = job.json.data.status_url as string;
    for (let i = 0; i < 120; i++) {
      const s = await platform("GET", url, undefined, owner);
      if (["succeeded", "failed", "cancelled"].includes(s.json.data.status)) { expect(s.json.data.status).toBe("succeeded"); break; }
      await new Promise((r) => setTimeout(r, 2000));
    }
    await c.query(`update app.listings set status = 'published', published_at = now(), title = $2, kind = 'room', rent_minor = 410000,
                   currency = 'TND', rent_period = 'month', furnished = true, bills_included = true, amenities = '{wifi,desk}',
                   house_rules = '{"smoking": "no"}', city = 'Tunis', neighbourhood = 'Lafayette', is_synthetic = true,
                   location = st_setsrid(st_makepoint(10.1815, 36.8065), 4326)::geography where id = $1`, [lid, `Chambre ${word}`]);
  } finally {
    await c.query("update app.settings set value = $1 where key = 'vision.enabled'", [JSON.stringify(vision)]);
    await c.end();
  }
  return lid;
}

export async function withdrawListing(id: string) {
  const c = await db();
  await c.query("update app.listings set status = 'archived' where id = $1", [id]);
  await c.end();
}

/** One statement on the stack's database (n8n_worker), for arranging what the website cannot (a test place). */
export async function sql(query: string, params: unknown[] = []) {
  const c = await db();
  try { return (await c.query(query, params)).rows; } finally { await c.end(); }
}
