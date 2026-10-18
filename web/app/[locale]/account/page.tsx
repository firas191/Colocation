import { Fragment } from "react";
import { getFormatter, getTranslations, setRequestLocale } from "next-intl/server";
import { requireMember } from "@/lib/server/guard";
import { DeleteAccount } from "@/components/account/delete-account";
import { NotifyPrefs } from "@/components/account/notify-prefs";
import { api } from "@/lib/server/api";
import { clientIp } from "@/lib/server/viewer";

export async function generateMetadata() {
  const t = await getTranslations("account");
  return { title: t("title") };
}

export default async function Account({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const me = await requireMember(locale);
  const t = await getTranslations("account");
  const fmt = await getFormatter();
  const date = (s: string) => fmt.dateTime(new Date(s), { dateStyle: "long" });
  const pr = await api<{ email: boolean; telegram: boolean; muted: string[]; telegram_linked: boolean }>("GET", "/v1/me/notification-preferences",
    { userId: me.user_id, clientIp: await clientIp() });
  const tn = await getTranslations("notifications");
  const types = Object.keys((tn.raw("types") as Record<string, string>) || {});
  const badges = (me.badges as Array<{ code?: string }>).map((b) => b?.code).filter((x): x is string => !!x);
  const rows: Array<[string, React.ReactNode]> = [
    [t("email"), <span key="e" className="ltr-island">{me.email}</span>],
    [t("role"), t(`roles.${me.role}`)],
    [t("since"), me.created_at ? date(me.created_at) : "—"],
  ];
  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-8">
      <h1 className="page-title">{t("title")}</h1>
      <dl className="grid grid-cols-[max-content_1fr] gap-x-8 gap-y-3">
        {rows.map(([k, v]) => (<Fragment key={k}><dt className="text-ink-soft">{k}</dt><dd>{v}</dd></Fragment>))}
      </dl>
      <section className="flex flex-col gap-3">
        <h2 className="text-xl font-semibold">{t("badgesTitle")}</h2>
        {/* each badge says exactly what was checked (P8, D-107); nothing here is an identity check */}
        {badges.length === 0 ? <p className="text-ink-soft">{t("badgesNone")}</p> : (
          <ul className="flex flex-wrap gap-2">
            {badges.map((b) => <li key={b} className="rounded-full border border-door px-3 py-1 text-sm">{t.has(`badges.${b}`) ? t(`badges.${b}`) : b}</li>)}
          </ul>
        )}
        <p className="text-sm text-ink-soft">{t("badgesNote")}</p>
      </section>
      <section className="flex flex-col gap-3">
        <h2 className="text-xl font-semibold">{t("consents")}</h2>
        <ul className="flex flex-col gap-1.5">
          {Object.entries(me.consents).map(([purpose, c]) => (
            <li key={purpose}>
              {t.has(`purposes.${purpose}`) ? t(`purposes.${purpose}`) : purpose}: {c.granted ? t("granted", { date: date(c.granted_at) }) : t("withdrawn")}
            </li>
          ))}
        </ul>
      </section>
      {pr.ok && <NotifyPrefs initial={{ email: pr.data.email, telegram: pr.data.telegram, muted: pr.data.muted }} types={types} linked={pr.data.telegram_linked} />}
      <DeleteAccount />
    </div>
  );
}
