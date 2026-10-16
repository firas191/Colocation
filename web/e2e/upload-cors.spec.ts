// Spec 17.1 "upload flow": a page on the website's origin uploads a photo straight to a presigned URL (the storage
// proxy answers the browser's CORS preflight); a page on any other origin cannot.
import { expect, test } from "@playwright/test";
import { platform } from "./helpers";

test.skip(({ browserName }) => browserName !== "chromium");

async function presignedUrl() {
  const sync = await platform("POST", "/v1/users/sync", { external_auth_id: `e2e-upload-${Date.now()}`, jurisdiction_code: "TN" });
  const uid = sync.json.data.user_id as string;
  await platform("POST", "/v1/me/consents", { consents: [{ purpose: "terms", granted: true }, { purpose: "privacy", granted: true },
    { purpose: "media_processing", granted: true }], policy_version: "e2e" }, uid);
  const listing = await platform("POST", "/v1/listings", { text: "Chambre test e2e", jurisdiction_code: "TN" }, uid);
  const lid = listing.json.data.listing_id as string;
  const p = await platform("POST", `/v1/listings/${lid}/media/presign`, { files: [{ kind: "photo", content_type: "image/jpeg", bytes: 3 }] }, uid);
  expect(p.status).toBe(200);
  return p.json.data.uploads[0] as { url: string; headers: Record<string, string> };
}

// Runs inside the page, so the browser applies its CORS rules.
async function put(u: { url: string; headers: Record<string, string> }) {
  try {
    const r = await fetch(u.url, { method: "PUT", headers: u.headers, body: new Uint8Array([0xff, 0xd8, 0xff]) });
    return r.status;
  } catch (e) {
    return String(e);
  }
}

test("the website's origin can upload to a presigned URL", async ({ page }) => {
  const u = await presignedUrl();
  await page.goto("/fr");
  const status = await page.evaluate(put, u);
  expect(status).toBe(200);
});

test("another origin cannot", async ({ page }) => {
  const u = await presignedUrl();
  // The same website under another origin (E2E_OTHER_ORIGIN; by default its address by IP).
  await page.goto((process.env.E2E_OTHER_ORIGIN || "http://127.0.0.1:3000") + "/fr");
  const status = await page.evaluate(put, u);
  expect(String(status)).toContain("TypeError");                                   // blocked by CORS
});
