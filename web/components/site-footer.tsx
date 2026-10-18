import { getTranslations } from "next-intl/server";
import { Link } from "@/i18n/navigation";
import { LogoMark } from "./floor-plan";
import { LocaleSwitcher } from "./locale-switcher";
import { CountrySwitcher } from "./country-switcher";
import { currentCountry } from "@/lib/server/country";
import { getMe } from "@/lib/server/viewer";

// One line of who we are and the two legal pages. No <nav> here: the header holds the site's only navigation.
export async function SiteFooter({ locale }: { locale: string }) {
  const t = await getTranslations("footer");
  const l = await getTranslations("legal");
  const n = await getTranslations("nav");
  const c = await getTranslations("countries");
  const me = await getMe().catch(() => null);
  const member = me && me.ok && me.data.consent_required.length === 0 ? me.data : null;
  const country = member ? await currentCountry(member) : null;
  return (
    <footer className="mt-16 border-t border-line">
      <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-4 px-4 py-8 text-sm text-ink-soft sm:px-6 lg:px-8">
        <p className="flex items-center gap-2"><LogoMark className="size-5" /> {t("tagline")}</p>
        {/* a div, not a p: the pickers are <details>, which may not sit inside a paragraph (the browser closed the
            paragraph early and the pickers escaped "sm:hidden", so they showed in the footer on wide screens too) */}
        <div className="flex flex-wrap items-center gap-x-5 gap-y-1">
          <Link href="/terms" className="text-ink-soft">{l("termsTitle")}</Link>
          <Link href="/privacy" className="text-ink-soft">{l("privacyTitle")}</Link>
          <span>{t("made")}</span>
          <div className="flex gap-2 sm:hidden">
            {member && country && <CountrySwitcher country={country} label={n("country")}
              countries={member.jurisdictions.map((j) => ({ code: j.code, name: c.has(j.code) ? c(j.code) : j.name }))} />}
            <LocaleSwitcher locale={locale} label={n("language")} />
          </div>
        </div>
      </div>
    </footer>
  );
}
