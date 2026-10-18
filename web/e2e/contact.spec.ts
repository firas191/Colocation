// Platform P4 definition of done, with two browsers side by side: a seeker writes to an owner about a listing, they
// agree a visit in one of the owner's slots, the seeker applies and the owner accepts; each step notifies the other
// side; once blocked, the seeker cannot write. (A third user seeing none of it: tests/contract/test_isolation.py.)
// Arranged in the database: the owner's published listing (publishing has its own test, owner.spec.ts).
import { expect, test } from "@playwright/test";
import { expectAccessible, expectNoSideScroll, signUpMember, sql } from "./helpers";

test("seeker and owner: message, visit, application, block", async ({ browser }, info) => {
  test.setTimeout(300_000);
  const base = { baseURL: info.project.use.baseURL, ...(info.project.use.viewport ? { viewport: info.project.use.viewport } : {}) };
  const ownerCtx = await browser.newContext(base);
  const seekerCtx = await browser.newContext(base);
  const owner = await ownerCtx.newPage();
  const seeker = await seekerCtx.newPage();
  const word = `p4${Date.now().toString(36)}${info.project.name.slice(0, 1)}`;
  const ownerEmail = await signUpMember(owner, "fr", `p4o-${info.project.name}`);
  await signUpMember(seeker, "fr", `p4s-${info.project.name}`);
  const ownerId = (await sql("select id from app.users where lower(email) = lower($1)", [ownerEmail]))[0].id as string;
  const listing = (await sql(`insert into app.listings (owner_id, jurisdiction_code, status, kind, title, description, rent_minor, currency,
      city, location, published_at, is_synthetic, source)
    values ($1, 'TN', 'published', 'room', $2, 'Chambre test P4', 380000, 'TND', 'Tunis',
      st_setsrid(st_makepoint(10.18, 36.80), 4326)::geography, now(), true, 'synthetic') returning id`, [ownerId, `Chambre ${word}`]))[0].id as string;
  await sql("delete from app.rate_counters where bucket like 'ip:%'");
  try {
    // the owner opens a visit time
    await owner.goto(`/fr/owner/listings/${listing}`);
    await owner.getByRole("button", { name: "Ajouter un horaire" }).click();
    const d = new Date(Date.now() + 3 * 86400_000);
    const day = d.toISOString().slice(0, 10);
    await owner.locator("input[type=datetime-local]").nth(0).fill(`${day}T18:00`);
    await owner.locator("input[type=datetime-local]").nth(1).fill(`${day}T19:00`);
    await owner.getByRole("button", { name: "Enregistrer les horaires" }).click();
    await expect(owner.getByText("Horaires enregistrés.")).toBeVisible();

    // the seeker writes from the listing page
    await seeker.goto(`/fr/listings/${listing}`);
    await expectNoSideScroll(seeker);
    await expectAccessible(seeker);
    await seeker.locator("#first-message").fill("Bonjour, la chambre est-elle libre en décembre ?");
    await seeker.getByRole("button", { name: "Envoyer", exact: true }).click();
    await seeker.waitForURL(/\/fr\/messages\/[0-9a-f-]{36}$/);
    const conv = seeker.url();
    await expect(seeker.getByText("la chambre est-elle libre en décembre ?")).toBeVisible();

    // the owner sees it, answers
    await owner.goto("/fr/notifications");
    await expect(owner.getByRole("link", { name: /Nouveau message de/ })).toBeVisible();
    await owner.goto("/fr/messages");
    await owner.getByRole("link", { name: /libre en décembre/ }).click();
    await owner.locator("#reply").fill("Oui, venez la visiter.");
    await owner.getByRole("button", { name: "Envoyer", exact: true }).click();
    await expect(owner.getByText("Oui, venez la visiter.")).toBeVisible();
    await expectNoSideScroll(owner);

    // the seeker asks for the visit, the owner confirms
    await seeker.goto(`/fr/listings/${listing}`);
    await seeker.getByRole("button", { name: /^Demander cette visite/ }).click();
    await expect(seeker.getByText("Visite demandée. Le propriétaire va confirmer.")).toBeVisible();
    await owner.goto("/fr/visits");
    await owner.getByRole("button", { name: "Confirmer" }).click();
    await expect(owner.getByText(/Chez vous · confirmée/)).toBeVisible();
    await seeker.goto("/fr/notifications");
    await expect(seeker.getByRole("link", { name: "Visite confirmée." })).toBeVisible();

    // the seeker applies, the owner accepts
    await seeker.goto(`/fr/listings/${listing}`);
    await seeker.locator("#apply-message").fill("Étudiant en master, calme et non-fumeur.");
    await seeker.getByRole("button", { name: "Envoyer ma candidature" }).click();
    await expect(seeker.getByText("Candidature envoyée.")).toBeVisible();
    await owner.goto("/fr/applications");
    await expect(owner.getByText("Étudiant en master, calme et non-fumeur.")).toBeVisible();
    await expectAccessible(owner);
    await owner.getByRole("button", { name: "Accepter" }).click();
    await expect(owner.locator("section[aria-labelledby='received-title']").getByText("acceptée")).toBeVisible();
    await seeker.goto("/fr/notifications");
    await expect(seeker.getByRole("link", { name: new RegExp(`candidature pour « Chambre ${word} » est acceptée`) })).toBeVisible();

    // Both browsers share one address, and so the API's per-address limit (the contract tests do the same, F-045).
    await sql("delete from app.rate_counters where bucket like 'ip:%'");
    // the owner blocks the seeker: the seeker can no longer write
    await owner.goto(conv);
    await owner.getByRole("button", { name: "Bloquer" }).click();
    await expect(owner.getByText("Bloqué.")).toBeVisible();
    await seeker.goto(conv);
    await expect(seeker.getByText("Les messages sont bloqués entre vous deux.")).toBeVisible();
    await seeker.locator("#reply").fill("Pourquoi ?");
    await seeker.getByRole("button", { name: "Envoyer", exact: true }).click();
    await expect(seeker.getByText("Vous ne pouvez pas écrire à cette personne.")).toBeVisible();
    await expectNoSideScroll(seeker);
  } finally {
    await sql("update app.listings set status = 'archived' where id = $1", [listing]);
    await ownerCtx.close();
    await seekerCtx.close();
  }
});
