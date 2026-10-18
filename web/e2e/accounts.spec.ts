// Platform P1 definition of done: a new person signs up in each language, confirms the address by e-mail, accepts
// consent, saves the lifestyle profile and finds it again after logging out and in. Arabic pages are right to
// left; nothing scrolls sideways at 360 px; no serious accessibility violation on these pages.
import { expect, test } from "@playwright/test";
import { expectAccessible, expectNoSideScroll, latestMailTo, linkIn, uniqueEmail } from "./helpers";

const TEXT = {
  fr: { create: "Créer le compte", verifyTitle: "Confirmez votre adresse", consent: "Avant de commencer", continue: "Continuer",
        profile: "Mon profil", save: "Enregistrer le profil", saved: "Profil enregistré.", logout: "Se déconnecter", login: "Se connecter",
        mail: "Confirmez", area: "Quartier, ville ou lieu de référence", max: "Maximum", smokingNo: "Non", smoke: "Je fume" },
  en: { create: "Create the account", verifyTitle: "Confirm your address", consent: "Before you start", continue: "Continue",
        profile: "My profile", save: "Save the profile", saved: "Profile saved.", logout: "Log out", login: "Log in",
        mail: "Confirm", area: "Neighbourhood, town or landmark", max: "Maximum", smokingNo: "No", smoke: "I smoke" },
  ar: { create: "إنشاء الحساب", verifyTitle: "أكّد عنوانك", consent: "قبل أن تبدأ", continue: "متابعة",
        profile: "ملفي", save: "حفظ الملف", saved: "تم حفظ الملف.", logout: "تسجيل الخروج", login: "دخول",
        mail: "أكّد", area: "الحي أو المدينة أو مكان مرجعي", max: "الحد الأقصى", smokingNo: "لا", smoke: "أدخّن" },
} as const;

for (const locale of ["fr", "en", "ar"] as const) {
  test(`sign up, confirm, consent, profile, log out and in (${locale})`, async ({ page }, info) => {
    const x = TEXT[locale];
    const email = uniqueEmail(`${locale}-${info.project.name}`);
    const password = "correct-horse-battery"; // pragma: allowlist secret (test account in the sandbox)

    await page.goto(`/${locale}/signup`);
    await expect(page.locator("html")).toHaveAttribute("dir", locale === "ar" ? "rtl" : "ltr");
    await expect(page.locator("html")).toHaveAttribute("lang", locale);
    await expectNoSideScroll(page);
    await expectAccessible(page);
    await page.locator("#name").fill("Amel");
    await page.locator("#email").fill(email);
    await page.locator("#password").fill(password);
    await page.getByRole("button", { name: x.create }).click();
    await expect(page.getByRole("heading", { name: x.verifyTitle })).toBeVisible();

    // The confirmation mail is in the page's language; its link logs the person in and opens the consent page.
    const mail = await latestMailTo(email, x.mail);
    await page.goto(linkIn(mail.Text));
    await expect(page.getByRole("heading", { name: x.consent })).toBeVisible();
    await expectNoSideScroll(page);
    await expectAccessible(page);
    for (const id of ["#terms", "#privacy", "#adult"]) await page.locator(id).check();
    await page.getByRole("button", { name: x.continue }).click();

    await expect(page.getByRole("heading", { level: 1, name: x.profile })).toBeVisible();
    await expect(page.getByRole("navigation").getByRole("link", { name: x.profile })).toBeVisible();   // header knows the member
    await expectNoSideScroll(page);
    await expectAccessible(page);
    await page.getByLabel(x.area).fill("Ennasr");
    await page.locator("#budget_max").fill("450");
    await page.getByRole("group", { name: x.smoke }).getByText(x.smokingNo, { exact: true }).click();   // the visible pill
    await page.locator('input[name="languages"][value="ar"]').check();
    await page.getByRole("button", { name: x.save }).click();
    await expect(page.getByText(x.saved)).toBeVisible();

    // log out is in the header's menu (D-116), the menu that holds the log-out button (not the country or language one)
    await page.locator("header details", { has: page.locator("button", { hasText: x.logout }) }).locator("summary").click();
    await page.getByRole("button", { name: x.logout }).click();
    // wait for the log-out to land on the home page: going to /login before it raced with its redirect (T-84)
    await page.waitForURL((u) => /^\/(fr|en|ar)\/?$/.test(u.pathname));
    await page.goto(`/${locale}/login`);
    await page.locator("#email").fill(email);
    await page.locator("#password").fill(password);
    await page.getByRole("button", { name: x.login, exact: true }).click();
    await expect(page.getByRole("heading", { level: 1, name: x.profile })).toBeVisible();
    await expect(page.locator("#budget_max")).toHaveValue("450");
    await expect(page.getByLabel(x.area)).toHaveValue("Ennasr");
    await expect(page.locator('input[name="smoking"][value="no"]')).toBeChecked();
    await expect(page.locator('input[name="languages"][value="ar"]')).toBeChecked();
  });
}

test("pages that need an account send the visitor to log in", async ({ page }) => {
  for (const path of ["/fr/profile", "/en/notifications", "/ar/account", "/fr/consent"]) {
    await page.goto(path);
    await expect(page).toHaveURL(/\/(fr|en|ar)\/login$/);
  }
});

test("wrong password and unknown address give the same answer", async ({ page }) => {
  await page.goto("/en/login");
  await page.locator("#email").fill(uniqueEmail("nobody"));
  await page.locator("#password").fill("whatever-password");
  await page.getByRole("button", { name: "Log in", exact: true }).click();
  await expect(page.getByText("Wrong address or password.")).toBeVisible();
});

test("password reset by e-mail", async ({ page }) => {
  const email = uniqueEmail("reset");
  await page.goto("/en/signup");
  await page.locator("#email").fill(email);
  await page.locator("#password").fill("first-password-1");
  await page.getByRole("button", { name: "Create the account" }).click();
  await page.goto(linkIn((await latestMailTo(email, "Confirm")).Text));          // confirmed and logged in
  await page.getByRole("button", { name: "Log out" }).click();
  await page.goto("/en/reset");
  await page.locator("#email").fill(email);
  await page.getByRole("button", { name: "Send the link" }).click();
  await expect(page.getByText("If an account exists for this address")).toBeVisible();
  await page.goto(linkIn((await latestMailTo(email, "new password")).Text));
  await page.locator("#password").fill("second-password-2");
  await page.getByRole("button", { name: "Save the password" }).click();
  await expect(page.getByText("Password changed.")).toBeVisible();
  await page.goto("/en/login");
  await page.locator("#email").fill(email);
  await page.locator("#password").fill("second-password-2");
  await page.getByRole("button", { name: "Log in", exact: true }).click();
  await expect(page).toHaveURL(/\/en\/(consent|profile)$/);
});
