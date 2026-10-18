// /admin/moderation (platform P8, D-107; backend spec 12.5): the moderation queue for moderators and admins. Listings
// the trust check sent to review show their score and signals; reports show their reasons. Each decision is written
// to the audit log by the API.
import { notFound } from "next/navigation";
import { getFormatter, getTranslations, setRequestLocale } from "next-intl/server";
import { Link } from "@/i18n/navigation";
import { Notice } from "@/components/ui/field";
import { DecisionForm } from "@/components/admin/decision-form";
import { requireMember } from "@/lib/server/guard";
import { api } from "@/lib/server/api";
import { clientIp } from "@/lib/server/viewer";

interface Item { item_id: number; entity_type: string; entity_id: string; reason: string; priority: number; status: string; reports: number;
  created_at: string; evidence: { score?: number; signals?: { signal: string; points: number; quote?: string; source?: string }[] };
  note?: string | null;
  listing?: { listing_id: string; title: string | null; status: string; description: string | null; trust_score: number | null;
    owner: { display_name: string | null } } | null;
  message?: { body: string | null; hidden: boolean } | null; user?: { display_name: string | null } | null;
  report_reasons: { reason: string; detail: string | null }[]; actions: string[] }

export async function generateMetadata() {
  return { title: (await getTranslations("admin"))("moderation") };
}

export default async function Moderation({ params, searchParams }: { params: Promise<{ locale: string }>; searchParams: Promise<{ status?: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const me = await requireMember(locale);
  if (!me.flags.is_staff) notFound();
  const sp = await searchParams;
  const status = ["open", "approved", "rejected", "all"].includes(sp.status || "") ? sp.status! : "open";
  const t = await getTranslations("admin");
  const o = await getTranslations("owner");
  const e = await getTranslations("errors");
  const fmt = await getFormatter();
  const r = await api<{ items: Item[] }>("GET", "/v1/admin/moderation", { userId: me.user_id, clientIp: await clientIp(), query: { status, limit: "50" } });
  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-6">
      <h1 className="page-title">{t("moderation")}</h1>
      <nav aria-label={t("filter")} className="flex flex-wrap gap-2">
        {["open", "approved", "rejected", "all"].map((s) => (
          <Link key={s} href={`/admin/moderation?status=${s}`} aria-current={s === status ? "page" : undefined}
            className={`inline-flex min-h-10 items-center rounded-full border px-4 text-sm no-underline ${s === status ? "border-door bg-door text-door-ink" : "border-line bg-paper text-ink"}`}>{t(`status.${s}`)}</Link>
        ))}
      </nav>
      {!r.ok ? <Notice tone="error">{e.has(r.error.code) ? e(r.error.code) : e("INTERNAL")}</Notice>
        : r.data.items.length === 0 ? <p className="text-ink-soft">{t("empty")}</p> : (
          <ul className="flex flex-col gap-4">
            {r.data.items.map((it) => (
              <li key={it.item_id}>
                <article className="flex flex-col gap-3 panel p-4">
                  <p className="text-sm font-semibold text-ink-soft">
                    {t(`kinds.${it.entity_type}`)} · {t.has(`reasons.${it.reason}`) ? t(`reasons.${it.reason}`) : it.reason} · {t("priority", { n: it.priority })}
                    {it.reports > 0 ? ` · ${t("reports", { count: it.reports })}` : ""}
                  </p>
                  {it.listing && (
                    <div className="flex flex-col gap-1">
                      <h2 className="text-lg font-semibold [overflow-wrap:anywhere]"><Link href={`/listings/${it.listing.listing_id}`} className="link-title">{it.listing.title || "—"}</Link></h2>
                      <p className="text-sm text-ink-soft">{it.listing.owner.display_name || "—"} · {it.listing.status}{it.listing.trust_score !== null ? ` · ${t("score", { n: it.listing.trust_score })}` : ""}</p>
                      {it.listing.description && <p className="whitespace-pre-line text-sm [overflow-wrap:anywhere]">{it.listing.description}</p>}
                    </div>
                  )}
                  {it.message && <blockquote className="border-s-4 border-line ps-3 [overflow-wrap:anywhere]">{it.message.body ?? "—"}</blockquote>}
                  {it.user && !it.message && <p>{it.user.display_name || "—"}</p>}
                  {(it.evidence.signals || []).length > 0 && (
                    <ul className="flex flex-col gap-1 text-sm">
                      {(it.evidence.signals || []).map((s) => (
                        <li key={s.signal}>{o.has(`signals.${s.signal}`) ? o(`signals.${s.signal}`) : s.signal} ({s.points}){s.quote ? ` : « ${s.quote} »` : ""}</li>
                      ))}
                    </ul>
                  )}
                  {/* the Trust agent's or the detector's note (D-114): model text, shown as such */}
                  {it.note && <p className="text-sm [overflow-wrap:anywhere]"><span className="font-semibold">{t("checkNote")}</span> {it.note}</p>}
                  {it.report_reasons.length > 0 && (
                    <ul className="flex flex-col gap-1 text-sm">
                      {it.report_reasons.map((x, i) => <li key={i}>{t.has(`reportReasons.${x.reason}`) ? t(`reportReasons.${x.reason}`) : x.reason}{x.detail ? ` : ${x.detail}` : ""}</li>)}
                    </ul>
                  )}
                  <p className="text-xs text-ink-soft">{fmt.dateTime(new Date(it.created_at), { dateStyle: "medium", timeStyle: "short" })}</p>
                  {it.actions.length > 0 && <DecisionForm itemId={it.item_id} actions={it.actions} />}
                </article>
              </li>
            ))}
          </ul>
        )}
    </div>
  );
}
