// /saved-searches (platform P7): searches saved from /search. With the daily alert on, each listing published later
// that matches is sent once (social.daily_alerts, D-106).
import { getFormatter, getTranslations, setRequestLocale } from "next-intl/server";
import { Link } from "@/i18n/navigation";
import { Empty, Notice } from "@/components/ui/field";
import { ActionButton } from "@/components/home/action-button";
import { requireMember } from "@/lib/server/guard";
import { api } from "@/lib/server/api";
import { clientIp } from "@/lib/server/viewer";
import { searchHref, type SavedSearch } from "@/lib/flatmates";

export async function generateMetadata() {
  return { title: (await getTranslations("flatmates"))("savedSearches") };
}

export default async function SavedSearches({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const me = await requireMember(locale);
  const t = await getTranslations("flatmates");
  const e = await getTranslations("errors");
  const fmt = await getFormatter();
  const r = await api<{ items: SavedSearch[] }>("GET", "/v1/me/saved-searches", { userId: me.user_id, clientIp: await clientIp() });
  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6">
      <h1 className="page-title">{t("savedSearches")}</h1>
      <p className="text-ink-soft">{t("savedLead")}</p>
      {!r.ok ? <Notice tone="error">{e.has(r.error.code) ? e(r.error.code) : e("INTERNAL")}</Notice>
        : r.data.items.length === 0 ? <Empty action={<Link href="/search" className="btn btn-primary">{t("toSearch")}</Link>}>{t("savedEmpty")}</Empty> : (
          <ul className="flex flex-col gap-4">
            {r.data.items.map((s) => (
              <li key={s.saved_search_id} className="flex flex-col gap-2 panel p-4">
                <h2 className="text-lg font-semibold [overflow-wrap:anywhere]"><Link href={searchHref(s.query)} className="link-title">{s.name}</Link></h2>
                <p className="text-sm text-ink-soft">{s.alert === "daily" ? t("alertDaily") : t("alertNone")} · {t("hits", { count: s.hits })}
                  {s.last_alert_at ? ` · ${t("lastAlert", { date: fmt.dateTime(new Date(s.last_alert_at), { dateStyle: "medium" }) })}` : ""}</p>
                <ActionButton method="DELETE" path={`/v1/me/saved-searches/${s.saved_search_id}`} variant="quiet">{t("delete")}</ActionButton>
              </li>
            ))}
          </ul>
        )}
    </div>
  );
}
