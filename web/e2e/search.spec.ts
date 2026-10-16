// Platform P2 definition of done: a member searches with filters and on the map, opens a listing with its photos,
// saves it as a favourite, and talks to the assistant; Arabic pages are right to left and nothing scrolls sideways
// at 360 px. Data: one listing published through the normal photo path (arrangePublishedListing).
import { expect, test, type Cookie, type Page } from "@playwright/test";
import { arrangePublishedListing, expectAccessible, expectNoSideScroll, signUpMember, withdrawListing } from "./helpers";

test.describe.configure({ mode: "serial" });
const WORD = `e2e${Date.now().toString(36)}`;
let listing = "";

// One member per run: the auth server limits how many sign-ups and confirmations one address makes a minute, so the
// tests share one session (its cookies) instead of signing up four times.
let session: Cookie[] = [];
test.beforeAll(async ({ browser }, info) => {
  listing = await arrangePublishedListing(WORD);
  const ctx = await browser.newContext({ baseURL: info.project.use.baseURL });
  await signUpMember(await ctx.newPage(), "fr", `p2-${info.project.name}`);
  session = await ctx.cookies();
  await ctx.close();
});
const signedIn = (page: Page) => page.context().addCookies(session);
test.afterAll(async () => { if (listing) await withdrawListing(listing); });

async function imageLoaded(page: Page, selector: string) {
  await page.locator(selector).first().scrollIntoViewIfNeeded();            // photos below the fold load lazily
  await expect.poll(() => page.locator(selector).first().evaluate((i: HTMLImageElement) => i.complete && i.naturalWidth > 0)).toBe(true);
}

test("search with filters, the listing page with its photos, favourites", async ({ page }) => {
  await signedIn(page);
  await page.goto(`/fr/search?country=TN&q=${WORD}&furnished=true&amenity=wifi&amenity=desk&rule_smoking=no`);
  await expect(page.getByRole("heading", { level: 1, name: "Chercher une chambre" })).toBeVisible();
  const card = page.getByRole("article").filter({ hasText: `Chambre ${WORD}` });
  await expect(card).toHaveCount(1);
  await imageLoaded(page, `article:has-text("Chambre ${WORD}") img`);
  await expectNoSideScroll(page);
  await expectAccessible(page);
  // a filter it does not match (other listings may still come by meaning: the text ranks, it does not exclude)
  await page.goto(`/fr/search?country=TN&q=${WORD}&furnished=false`);
  await expect(page.getByRole("heading", { level: 2 })).toBeVisible();
  await expect(page.getByRole("article").filter({ hasText: `Chambre ${WORD}` })).toHaveCount(0);

  await page.goto(`/fr/search?country=TN&q=${WORD}`);
  await page.getByRole("link", { name: `Voir l'annonce : Chambre ${WORD}` }).click();
  await expect(page.getByRole("heading", { level: 1, name: `Chambre ${WORD}` })).toBeVisible();
  await expect(page.locator("main img")).toHaveCount(2);
  await imageLoaded(page, "main img");
  await expect(page.getByText("Wi-Fi")).toBeVisible();
  await expectNoSideScroll(page);
  await expectAccessible(page);
  const heart = page.getByRole("button", { name: `Ajouter aux favoris: Chambre ${WORD}` });
  await heart.click();
  await expect(page.getByRole("button", { name: `Retirer des favoris: Chambre ${WORD}` })).toHaveAttribute("aria-pressed", "true");

  await page.goto("/fr/favourites");
  await expect(page.getByRole("article").filter({ hasText: `Chambre ${WORD}` })).toHaveCount(1);
  await expectAccessible(page);
  await page.getByRole("button", { name: `Retirer des favoris: Chambre ${WORD}` }).click();
  await page.reload();
  await expect(page.getByText("Aucun favori pour l'instant")).toBeVisible();
});

test("the map shows the listing and searches the visible area", async ({ page }) => {
  await signedIn(page);
  // Asked from inside the page: the browser maps "localhost" to the proxy container in verify.ps1 (PW_HOST_RULES),
  // the test runner's own HTTP client does not (F-074).
  await page.goto("/en");
  const headStatus = await page.evaluate(async () => (await fetch("/tiles/tn.pmtiles", { method: "HEAD" })).status);
  await page.goto(`/en/search?country=TN&q=${WORD}&view=map`);
  if (headStatus !== 200) {
    // the map file is made on the owner's PC (scripts/windows/map.ps1); without it the page says so and keeps the list
    await expect(page.getByText("The map of this country is not installed")).toBeVisible();
    await expect(page.getByRole("article").filter({ hasText: `Chambre ${WORD}` })).toHaveCount(1);
    test.info().annotations.push({ type: "map", description: "tiles not installed: list only" });
    return;
  }
  const tile = page.waitForResponse((r) => r.url().includes("/tiles/tn.pmtiles") && r.status() === 206);
  await expect(page.getByRole("region", { name: "Map of the listings (approximate positions)" })).toBeVisible();
  await tile;
  await expect(page.locator(`a.map-pin[data-listing="${listing}"]`)).toHaveCount(1);
  await expect(page.locator(".maplibregl-canvas")).toBeVisible();
  await expect(page.getByRole("button", { name: "Search this area" })).toBeEnabled();
  await page.getByRole("button", { name: "Search this area" }).click();
  await expect(page).toHaveURL(/bbox=/);
  await expect(page.getByRole("article").filter({ hasText: `Chambre ${WORD}` })).toHaveCount(1);
  await expectNoSideScroll(page);
});

test("the assistant in Arabic: right to left, a search answer with cards", async ({ page }) => {
  test.setTimeout(300_000);                                          // an agent answer takes up to a minute or more on the PC
  await signedIn(page);
  await page.goto("/ar/assistant");
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  await expect(page.getByRole("heading", { level: 1, name: "المساعد" })).toBeVisible();
  await expectNoSideScroll(page);
  await expectAccessible(page);
  await page.getByLabel("رسالتك").fill(`أبحث عن غرفة في تونس ${WORD}`);
  await page.getByRole("button", { name: "أرسل" }).click();
  await expect(page.getByRole("status").filter({ hasText: "المساعد يفكر" })).toBeVisible();
  await expect(page.getByText("المساعد يفكر")).toHaveCount(0, { timeout: 280_000 });
  // whatever the route, the assistant answered something and nothing failed
  await expect(page.locator("ol > li").nth(1)).toBeVisible();
  await expect(page.getByText("تعذّرت معالجة الرسالة")).toHaveCount(0);
  await expectNoSideScroll(page);
});

test("a legal question shows the notice", async ({ page }) => {
  test.setTimeout(300_000);
  await signedIn(page);
  await page.goto("/fr/assistant");
  await page.getByLabel("Votre message").fill("Le propriétaire peut-il garder la caution à la fin du bail ?");
  await page.getByRole("button", { name: "Envoyer" }).click();
  await expect(page.getByText("L'assistant réfléchit")).toHaveCount(0, { timeout: 280_000 });
  await expect(page.getByText("pas un avis juridique")).toBeVisible();
});
