// Platform P3 definition of done: an owner posts a listing with three photos from a phone-sized browser, fixes a
// missing rent, publishes, finds it in the search, then archives it. Everything goes through the pages: the text,
// the photo consent, the browser upload to presigned URLs, the analysis job, the correction form, publication.
// Arranged in the database only: a place of its own in TN (the gazetteer differs between the PC and the sandbox),
// vision.enabled off during the test (the photo checks run, not the P7 model; it is timed in T-59), and
// listing.auto_publish off (on the PC it may be on for Telegram demos, D-083; it would publish at the first save, F-077),
// and trust.agent_enabled off: publishing runs the trust check as a job (D-112) with its rules and database checks,
// without the Trust agent, whose verdicts on the local model are the trust bench's business (T-77).
import { expect, test } from "@playwright/test";
import { expectAccessible, expectNoSideScroll, signUpMember, sql, uniquePhotos } from "./helpers";

test.describe.configure({ mode: "serial" });

test("an owner posts, fixes the rent, publishes, finds and archives a listing", async ({ page }, info) => {
  test.setTimeout(600_000);                                  // the analysis job runs the text model on the PC
  const word = `p3${Date.now().toString(36)}${info.project.name.slice(0, 1)}`;
  const placeName = `Quartier ${word}`;
  await sql(`insert into app.places (jurisdiction_code, kind, name, place_key, city, location, source)
             values ('TN', 'neighbourhood', $1, $2, 'Tunis', st_setsrid(st_makepoint(10.18, 36.80), 4326)::geography, 'test')`,
            [placeName, `e2e-${word}`]);
  await sql("insert into app.place_names (place_id, name) select id, $1 from app.places where place_key = $2", [placeName, `e2e-${word}`]);
  const vision = (await sql("select value from app.settings where key = 'vision.enabled'"))[0].value;
  await sql("update app.settings set value = 'false' where key = 'vision.enabled'");
  const auto = (await sql("select value from app.settings where key = 'listing.auto_publish'"))[0].value;
  await sql("update app.settings set value = 'false' where key = 'listing.auto_publish'");
  const agent = (await sql("select value from app.settings where key = 'trust.agent_enabled'"))[0].value;
  await sql("update app.settings set value = 'false' where key = 'trust.agent_enabled'");
  try {
    await signUpMember(page, "fr", `p3-${info.project.name}`);

    // 1. the text, without a rent
    await page.goto("/fr/owner/new");
    await expect(page.getByRole("heading", { level: 1, name: "Publier une annonce" })).toBeVisible();
    await expectNoSideScroll(page);
    await expectAccessible(page);
    await page.locator("#jurisdiction_code").selectOption("TN");
    await page.locator("#text").fill(`Chambre ${word} meublée, wifi et bureau, libre en novembre`);
    await page.getByRole("button", { name: "Continuer vers les photos" }).click();
    await page.waitForURL(/\/fr\/owner\/listings\/[0-9a-f-]{36}$/);

    // 2. three photos of its own (the trust check would rightly find the shared fixture photos on other listings,
    //    T-79): the photo consent is asked first (not given at sign-up), then the upload and the analysis
    const files = await uniquePhotos(page, 3);
    await page.locator("#photos").setInputFiles(files);
    await page.getByRole("button", { name: /Analyser l'annonce/ }).click();
    await expect(page.getByRole("heading", { name: "Vos photos demandent votre accord" })).toBeVisible();
    await page.getByRole("button", { name: "J'accepte, continuer" }).click();
    await expect(page.getByText("Analyse terminée.")).toBeVisible({ timeout: 480_000 });
    await expect(page.locator("section[aria-labelledby='photos-title'] img")).toHaveCount(3);
    await expectNoSideScroll(page);
    await expectAccessible(page);

    // 3. the rent is missing: the page says so, the owner fills it in with the place
    const publish = page.locator("section[aria-labelledby='publish-title']");
    await expect(publish.getByText("le loyer", { exact: true })).toBeVisible();
    await expect(publish.getByRole("button", { name: "Publier" })).toBeDisabled();
    await page.locator("#rent").fill("420");
    await page.locator("#place").fill(placeName);
    await page.getByRole("button", { name: "Enregistrer les corrections" }).click();
    await expect(page.getByText("Enregistré.")).toBeVisible();
    await expect(publish.getByText("le loyer", { exact: true })).toHaveCount(0);

    // 4. publish
    await publish.getByRole("button", { name: "Publier" }).click();
    // the trust check job (D-112); after it the page reloads its data and says so in the status section too
    await expect(page.getByText(/Votre annonce est publiée\.|Cette annonce est publiée\./).first()).toBeVisible({ timeout: 120_000 });

    // 5. a search finds it
    await page.goto(`/fr/search?country=TN&q=${word}`);
    const card = page.getByRole("article").filter({ hasText: `Chambre ${word}` });
    await expect(card).toHaveCount(1);
    await expect(card).toContainText("420");

    // 6. archive it from the list of the owner's listings
    await page.goto("/fr/owner/listings");
    await expect(page.getByRole("heading", { level: 1, name: "Mes annonces" })).toBeVisible();
    await expectNoSideScroll(page);
    await expectAccessible(page);
    const row = page.getByRole("article").filter({ hasText: `Chambre ${word}` });
    await expect(row).toContainText("publiée");
    await row.getByRole("button", { name: /^Archiver/ }).click();
    await expect(row.getByText("Annonce archivée.")).toBeVisible();
    await page.goto(`/fr/search?country=TN&q=${word}`);
    await expect(page.getByRole("article").filter({ hasText: `Chambre ${word}` })).toHaveCount(0);
  } finally {
    await sql("update app.settings set value = $1 where key = 'vision.enabled'", [JSON.stringify(vision)]);
    await sql("update app.settings set value = $1 where key = 'listing.auto_publish'", [JSON.stringify(auto)]);
    await sql("update app.settings set value = $1 where key = 'trust.agent_enabled'", [JSON.stringify(agent)]);
    await sql("update app.listings set status = 'archived' where description like $1", [`Chambre ${word}%`]);
    await sql("delete from app.places where place_key = $1", [`e2e-${word}`]);
  }
});
