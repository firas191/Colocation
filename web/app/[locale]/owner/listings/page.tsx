// /owner/listings (platform P3): GET /v1/me/listings with what each draft still needs and the actions the API allows,
// and the owner assistant beside the list (the same agent as on Telegram, D-088): it proposes, the owner confirms.
import { getFormatter, getTranslations, setRequestLocale } from "next-intl/server";
import { clsx } from "clsx";
import { Link } from "@/i18n/navigation";
import { Notice } from "@/components/ui/field";
import { Photo } from "@/components/listing/photo";
import { Chat } from "@/components/assistant/chat";
import { StatusButton } from "@/components/owner/status-button";
import { requireMember } from "@/lib/server/guard";
import { api } from "@/lib/server/api";
import { clientIp } from "@/lib/server/viewer";
import { money, place } from "@/lib/listing";
import { TABS, type MyListing, type MyListings } from "@/lib/owner";

export async function generateMetadata() {
  const t = await getTranslations("owner");
  return { title: t("listingsTitle") };
}

export const maxDuration = 300;     // the assistant panel waits for the agent (a minute or more on the PC)

export default async function MyListingsPage({ params, searchParams }:
  { params: Promise<{ locale: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const me = await requireMember(locale);
  const sp = await searchParams;
  const tab = (TABS as readonly string[]).includes(String(sp.status)) ? String(sp.status) : "all";
  const cursor = typeof sp.cursor === "string" ? sp.cursor : undefined;
  const t = await getTranslations("owner");
  const e = await getTranslations("errors");
  const sr = await getTranslations("search");
  const r = await api<MyListings>("GET", "/v1/me/listings", { userId: me.user_id, clientIp: await clientIp(), lang: locale,
    query: { status: tab === "all" ? undefined : tab, cursor, limit: "20" } });
  const next = r.ok ? (r.meta.next_cursor as string | null) : null;
  return (
    <div className="mx-auto grid max-w-6xl gap-10 lg:grid-cols-[1.5fr_1fr]">
      <div className="flex min-w-0 flex-col gap-6">
        <header className="flex flex-wrap items-end justify-between gap-4">
          <div className="flex flex-col gap-2">
            <h1 className="page-title">{t("listingsTitle")}</h1>
            <p className="max-w-prose text-ink-soft">{t("listingsLead")}</p>
          </div>
          <Link href="/owner/new" className="btn btn-primary">
            {t("new")}
          </Link>
        </header>
        {!r.ok ? <Notice tone="error">{e.has(r.error.code) ? e(r.error.code) : e("INTERNAL")}</Notice> : (
          <>
            <nav aria-label={t("tabsLabel")}>
              <ul className="flex flex-wrap gap-2">
                {TABS.map((x) => (
                  <li key={x}>
                    <Link href={x === "all" ? "/owner/listings" : `/owner/listings?status=${x}`} aria-current={x === tab ? "page" : undefined}
                      className={clsx("inline-flex min-h-10 items-center rounded-full border px-4 text-sm no-underline",
                        x === tab ? "border-door bg-door text-door-ink" : "border-line bg-paper text-ink hover:border-door")}>
                      {t(`tabs.${x}`)} <span className="ms-1.5 ltr-island">{r.data.counts[x]}</span>
                    </Link>
                  </li>
                ))}
              </ul>
            </nav>
            {r.data.warnings.includes("photos_unavailable") && <Notice>{sr("warnings.photos_unavailable")}</Notice>}
            {r.data.items.length === 0 ? <p className="text-ink-soft">{t("empty")}</p> : (
              <ul className="flex flex-col gap-4">
                {r.data.items.map((x) => <li key={x.listing_id}><Row x={x} locale={locale} /></li>)}
              </ul>
            )}
            {next && <Link href={`/owner/listings?${new URLSearchParams({ ...(tab !== "all" ? { status: tab } : {}), cursor: next })}`} rel="next" className="btn btn-secondary self-start">{t("more")}</Link>}
          </>
        )}
      </div>
      <aside aria-labelledby="assistant-title" className="flex min-w-0 flex-col gap-3 lg:sticky lg:top-6 lg:self-start">
        <h2 id="assistant-title" className="text-xl font-semibold">{t("assistantTitle")}</h2>
        <p className="text-sm text-ink-soft">{t("assistantLead")}</p>
        <Chat examples={[t("assistantEx1"), t("assistantEx2"), t("assistantEx3")]} compact placeholder={t("assistantEx1")} />
      </aside>
    </div>
  );
}

async function Row({ x, locale }: { x: MyListing; locale: string }) {
  const t = await getTranslations("owner");
  const l = await getTranslations("listing");
  const c = await getTranslations("card");
  const fmt = await getFormatter();
  const title = x.display_title || c("untitled");
  const price = money(locale, x.rent.amount_minor, x.rent.currency, x.rent.exponent ?? 2);
  const missing = x.readiness?.missing.map((m) => t(`missing.${m.field}`)) || [];
  return (
    <article className="flex flex-col gap-4 panel p-4 sm:flex-row">
      <div className="w-full shrink-0 sm:w-40">
        {x.cover_photo
          ? <Photo src={x.cover_photo.url} alt="" className="aspect-[4/3] w-full rounded-field object-cover" fallback={c("noPhoto")} loading="lazy" />
          : <div className="grid aspect-[4/3] w-full place-items-center rounded-field bg-raised text-sm text-ink-soft">{c("noPhoto")}</div>}
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <p className="flex flex-wrap items-center gap-2 text-sm">
          <span className={clsx("rounded-full px-2.5 py-0.5 font-semibold", x.status === "published" ? "bg-olive/15" : x.status === "draft" ? "bg-saffron/25" : "bg-raised")}>
            {l.has(`statuses.${x.status}`) ? l(`statuses.${x.status}`) : x.status}
          </span>
          {x.number && <span className="text-ink-soft" title={t("numberHint", { n: x.number })}>{t("number", { n: x.number })}</span>}
          <span className="text-ink-soft">{t("photos", { count: x.photo_count })}</span>
        </p>
        <h2 className="text-lg font-semibold [overflow-wrap:anywhere]">{title}</h2>
        <p className="text-ink-soft">{[price ? `${price} ${x.rent.period === "week" ? c("perWeek") : c("perMonth")}` : c("noRent"), place(x)].filter(Boolean).join(" · ")}</p>
        {x.analysis && ["queued", "running"].includes(x.analysis.status) && <p role="status">{t("analysisRunning")}</p>}
        {x.analysis?.status === "failed" && <p className="text-brick">{t("analysisFailed")}</p>}
        {x.status === "draft" && (x.readiness?.ready ? <p className="font-semibold text-olive">{t("ready")}</p>
          : missing.length > 0 && <p>{t("stillNeeded", { list: missing.join(", ") })}</p>)}
        <p className="text-sm text-ink-soft">{t("updated", { date: fmt.dateTime(new Date(x.updated_at), { dateStyle: "medium" }) })}</p>
        <div className="mt-1 flex flex-wrap items-start gap-3">
          {x.actions.edit && (
            <Link href={`/owner/listings/${x.listing_id}`} aria-label={`${x.status === "draft" ? t("continue") : t("manage")}: ${title}`}
              className="btn btn-primary">
              {x.status === "draft" ? t("continue") : t("manage")}
            </Link>
          )}
          {x.actions.view && <Link href={`/listings/${x.listing_id}`} className="link-action">{t("view")}</Link>}
          {x.actions.archive && x.status === "published" && <StatusButton listingId={x.listing_id} to="archived" title={title} />}
          {x.actions.republish && <StatusButton listingId={x.listing_id} to="published" title={title} />}
        </div>
      </div>
    </article>
  );
}
