// The site's header and its one <nav>: the main sections in the bar, everything else in "More", the notifications
// bell and the profile always in view. Light/dark toggle and language next to them (D-116).
import { getTranslations } from "next-intl/server";
import { Link } from "@/i18n/navigation";
import { LogoMark } from "./floor-plan";
import { LocaleSwitcher } from "./locale-switcher";
import { ThemeToggle } from "./theme-toggle";
import { CountrySwitcher } from "./country-switcher";
import { currentCountry } from "@/lib/server/country";
import { NavLink } from "./nav-link";
import { HeaderMenu } from "./header-menu";
import { signOutAction } from "@/lib/actions/auth";
import { getMe, getViewer } from "@/lib/server/viewer";

const item = "block rounded-field px-3 py-2 text-[0.95rem] text-ink no-underline hover:bg-raised aria-[current=page]:bg-door-soft aria-[current=page]:text-door";

export async function SiteHeader({ locale }: { locale: string }) {
  const t = await getTranslations("nav");
  const viewer = await getViewer();
  const me = viewer ? await getMe() : null;
  const unread = me && me.ok ? me.data.counts.unread_notifications : 0;
  const member = !!(me && me.ok && me.data.consent_required.length === 0);
  const name = me && me.ok ? me.data.display_name || me.data.email || "" : "";
  const c = await getTranslations("countries");
  const country = member && me && me.ok ? await currentCountry(me.data) : null;
  const countries = me && me.ok ? me.data.jurisdictions.map((j) => ({ code: j.code, name: c.has(j.code) ? c(j.code) : j.name })) : [];
  const primary = [["/search", t("search")], ["/flatmates", t("flatmates")], ["/households", t("households")], ["/messages", t("messages")]] as const;
  const more = [["/favourites", t("favourites")], ["/owner/listings", t("myListings")], ["/visits", t("visits")],
    ["/applications", t("applications")], ["/account", t("account")]] as const;
  return (
    <header className="sticky top-0 z-40 border-b border-line bg-plaster/85 backdrop-blur-md supports-[backdrop-filter]:bg-plaster/70">
      <div className="mx-auto flex h-16 max-w-7xl items-center gap-3 px-4 sm:px-6 lg:px-8">
        <Link href="/" className="me-2 flex items-center gap-2 font-[family-name:var(--font-display)] text-xl font-bold text-ink no-underline">
          <LogoMark className="size-8" /> Coloc
        </Link>
        {member ? (
          <nav aria-label={t("menu")} className="flex flex-1 items-center gap-1">
            <div className="hidden items-center gap-1 lg:flex">
              {primary.map(([h, l]) => <NavLink key={h} href={h}>{l}</NavLink>)}
              <NavLink href="/assistant" className="ms-1 border border-door/30">
                <span aria-hidden="true" className="me-1.5 inline-block size-2 rounded-full bg-bougain align-middle" />{t("assistant")}
              </NavLink>
            </div>
            <HeaderMenu label={<><span className="lg:hidden">{t("menu")}</span><span className="hidden lg:inline">{t("more")}</span></>} className="ms-auto lg:ms-1">
              <div className="flex flex-col gap-0.5 lg:hidden">
                {[...primary, ["/assistant", t("assistant")] as const].map(([h, l]) => <Link key={h} href={h} className={item}>{l}</Link>)}
                <hr className="my-1 border-line" />
              </div>
              {more.map(([h, l]) => <Link key={h} href={h} className={item}>{l}</Link>)}
              {me && me.ok && me.data.flags.is_staff && <Link href="/admin" className={item}>{t("moderation")}</Link>}
              <hr className="my-1 border-line" />
              <form action={signOutAction.bind(null, locale)}>
                <button className="block w-full rounded-field px-3 py-2 text-start text-[0.95rem] text-brick hover:bg-raised">{t("signOut")}</button>
              </form>
            </HeaderMenu>
            <div className="ms-auto flex items-center gap-1">
              <Link href="/notifications" aria-label={`${t("notifications")}: ${t("unread", { count: unread })}`}
                className="relative grid size-10 place-items-center rounded-full text-ink no-underline hover:bg-raised">
                <svg viewBox="0 0 24 24" aria-hidden="true" className="size-5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M6 9a6 6 0 1 1 12 0c0 6 2.5 7.5 2.5 7.5h-17S6 15 6 9Z" /><path d="M10 20a2 2 0 0 0 4 0" />
                </svg>
                {unread > 0 && <span className="absolute -end-0.5 -top-0.5 grid min-w-5 place-items-center rounded-full bg-bougain px-1 text-[0.7rem] font-bold text-bougain-ink ltr-island">{unread > 99 ? "99+" : unread}</span>}
              </Link>
              <ThemeToggle label={t("theme")} />
              {country && <div className="hidden sm:block"><CountrySwitcher country={country} countries={countries} label={t("country")} /></div>}
              <div className="hidden sm:block"><LocaleSwitcher locale={locale} label={t("language")} /></div>
              <Link href="/profile" aria-label={t("profile")} title={t("profile")}
                className="ms-1 grid size-9 place-items-center rounded-full bg-door font-[family-name:var(--font-display)] text-sm font-bold uppercase text-door-ink no-underline ring-2 ring-paper">
                {(name.trim()[0] || "?")}
              </Link>
            </div>
          </nav>
        ) : (
          <div className="ms-auto flex items-center gap-2">
            <ThemeToggle label={t("theme")} />
            <div className="hidden sm:block"><LocaleSwitcher locale={locale} label={t("language")} /></div>
            {viewer ? (
              <form action={signOutAction.bind(null, locale)}>
                <button className="btn btn-secondary min-h-10">{t("signOut")}</button>
              </form>
            ) : (
              <>
                <Link href="/login" className="rounded-full px-3 py-2 text-[0.95rem] font-medium text-ink no-underline hover:bg-raised">{t("signIn")}</Link>
                <Link href="/signup" className="btn btn-primary hidden min-h-10 sm:inline-flex">{t("signUp")}</Link>
              </>
            )}
          </div>
        )}
      </div>
    </header>
  );
}
