import { Fragment } from "react";
import { getFormatter, getTranslations, setRequestLocale } from "next-intl/server";
import { requireMember } from "@/lib/server/guard";

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
  const rows: Array<[string, React.ReactNode]> = [
    [t("email"), <span key="e" className="ltr-island">{me.email}</span>],
    [t("role"), t(`roles.${me.role}`)],
    [t("since"), me.created_at ? date(me.created_at) : "—"],
  ];
  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-8">
      <h1 className="text-3xl font-bold tracking-tight">{t("title")}</h1>
      <dl className="grid grid-cols-[max-content_1fr] gap-x-8 gap-y-3">
        {rows.map(([k, v]) => (<Fragment key={k}><dt className="text-ink-soft">{k}</dt><dd>{v}</dd></Fragment>))}
      </dl>
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
      <p className="text-sm text-ink-soft">{t("deleteSoon")}</p>
    </div>
  );
}
