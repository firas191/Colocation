// /visits (platform P4): the caller's visits, as seeker and at their own listings, with the actions that apply.
import { getFormatter, getTranslations, setRequestLocale } from "next-intl/server";
import { Link } from "@/i18n/navigation";
import { Empty, Notice } from "@/components/ui/field";
import { VisitActions } from "@/components/contact/visit-actions";
import { requireMember } from "@/lib/server/guard";
import { api } from "@/lib/server/api";
import { clientIp } from "@/lib/server/viewer";
import type { Visit } from "@/lib/contact";

export async function generateMetadata() {
  return { title: (await getTranslations("contact"))("visitsPage") };
}

export default async function Visits({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const me = await requireMember(locale);
  const t = await getTranslations("contact");
  const e = await getTranslations("errors");
  const fmt = await getFormatter();
  const r = await api<{ items: Visit[] }>("GET", "/v1/me/visits", { userId: me.user_id, clientIp: await clientIp() });
  if (!r.ok) return <Notice tone="error">{e.has(r.error.code) ? e(r.error.code) : e("INTERNAL")}</Notice>;
  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6">
      <h1 className="page-title">{t("visitsPage")}</h1>
      {r.data.items.length === 0 ? <Empty>{t("visitsEmpty")}</Empty> : (
        <ul className="flex flex-col gap-4">
          {r.data.items.map((v) => (
            <li key={v.visit_id}>
              <article className="flex flex-col gap-2 panel p-4">
                <p className="text-sm font-semibold text-ink-soft">{v.role === "owner" ? t("asOwner") : t("asSeeker")} · {t(`status.${v.status}`)}</p>
                <h2 className="text-lg font-semibold ltr-island">{fmt.dateTime(new Date(v.starts_at), { dateStyle: "full", timeStyle: "short" })}</h2>
                {v.listing && <p className="[overflow-wrap:anywhere]"><Link href={`/listings/${v.listing.listing_id}`} className="link-title">{v.listing.title}</Link></p>}
                <p>{t("with", { name: v.other.display_name || t("signedNames.unknown") })}</p>
                {v.note && <p className="text-ink-soft whitespace-pre-line [overflow-wrap:anywhere]">{v.note}</p>}
                {v.waiting_for && <p className="text-sm">{v.waiting_for === "me" ? t("waitingMe") : t("waitingOther")}</p>}
                <VisitActions v={v} />
              </article>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
