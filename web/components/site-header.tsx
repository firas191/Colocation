import { getTranslations } from "next-intl/server";
import { Link } from "@/i18n/navigation";
import { LogoMark } from "./floor-plan";
import { LocaleSwitcher } from "./locale-switcher";
import { signOutAction } from "@/lib/actions/auth";
import { getMe, getViewer } from "@/lib/server/viewer";

export async function SiteHeader({ locale }: { locale: string }) {
  const t = await getTranslations("nav");
  const viewer = await getViewer();
  const me = viewer ? await getMe() : null;
  const unread = me && me.ok ? me.data.counts.unread_notifications : 0;
  const member = me && me.ok && me.data.consent_required.length === 0;
  return (
    <header className="border-b border-line">
      <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-6 gap-y-2 px-4 py-3 sm:px-6">
        <Link href="/" className="flex items-center gap-2 text-lg font-bold text-ink no-underline">
          <LogoMark className="size-7" /> Coloc
        </Link>
        <nav aria-label={t("menu")} className="flex flex-1 flex-wrap items-center gap-x-5 gap-y-1 text-[0.95rem]">
          {member && <Link href="/search" className="text-ink no-underline hover:text-door">{t("search")}</Link>}
          {member && <Link href="/assistant" className="text-ink no-underline hover:text-door">{t("assistant")}</Link>}
          {member && <Link href="/favourites" className="text-ink no-underline hover:text-door">{t("favourites")}</Link>}
          {member && <Link href="/profile" className="text-ink no-underline hover:text-door">{t("profile")}</Link>}
          {member && (
            <Link href="/notifications" className="relative text-ink no-underline hover:text-door" aria-label={`${t("notifications")}: ${t("unread", { count: unread })}`}>
              {t("notifications")}
              {unread > 0 && <span className="ms-1.5 inline-grid min-w-5 place-items-center rounded-full bg-saffron px-1.5 text-xs font-bold text-ink ltr-island">{unread}</span>}
            </Link>
          )}
          {member && <Link href="/account" className="text-ink no-underline hover:text-door">{t("account")}</Link>}
        </nav>
        <div className="flex items-center gap-4">
          <LocaleSwitcher locale={locale} label={t("language")} />
          {viewer ? (
            <form action={signOutAction.bind(null, locale)}>
              <button className="text-[0.95rem] text-door underline-offset-4 hover:underline">{t("signOut")}</button>
            </form>
          ) : (
            <Link href="/login" className="text-[0.95rem]">{t("signIn")}</Link>
          )}
        </div>
      </div>
    </header>
  );
}
