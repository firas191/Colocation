// /listings/[id] (platform P2): GET /v1/listings/{id}/public. Photos are the processed copies, as signed URLs; the
// place is the neighbourhood and an approximate point, never the address.
import { Fragment } from "react";
import { getFormatter, getTranslations, setRequestLocale } from "next-intl/server";
import { Link } from "@/i18n/navigation";
import { Notice } from "@/components/ui/field";
import { FavouriteButton } from "@/components/listing/favourite-button";
import { Photo } from "@/components/listing/photo";
import { requireMember } from "@/lib/server/guard";
import { api } from "@/lib/server/api";
import { clientIp } from "@/lib/server/viewer";
import { money, place, type PhotoUrl, type PublicListing } from "@/lib/listing";

interface Data { listing: PublicListing; photos: Array<PhotoUrl & { media_id: string; width: number | null; height: number | null }>;
  photo_count: number; warnings: string[] }

export async function generateMetadata() {
  const t = await getTranslations("listing");
  return { title: t("details") };
}

export default async function ListingPage({ params }: { params: Promise<{ locale: string; id: string }> }) {
  const { locale, id } = await params;
  setRequestLocale(locale);
  const me = await requireMember(locale);
  const t = await getTranslations("listing");
  const c = await getTranslations("card");
  const s = await getTranslations("search");
  const a = await getTranslations("amenities");
  const e = await getTranslations("errors");
  const fmt = await getFormatter();
  const r = await api<Data>("GET", `/v1/listings/${encodeURIComponent(id)}/public`, { userId: me.user_id, clientIp: await clientIp(), lang: locale });
  const back = <Link href="/search">{t("back")}</Link>;
  if (!r.ok) {
    return (
      <div className="mx-auto flex max-w-3xl flex-col gap-6">
        {back}
        <Notice tone={r.status === 404 ? "info" : "error"}>{r.status === 404 ? t("notFound") : (e.has(r.error.code) ? e(r.error.code) : e("INTERNAL"))}</Notice>
      </div>
    );
  }
  const L = r.data.listing;
  const title = L.title || c("untitled");
  const exp = L.rent?.exponent ?? 2;
  const price = L.rent ? money(locale, L.rent.amount_minor, L.rent.currency, exp) : null;
  const date = (d: string) => fmt.dateTime(new Date(d.length === 10 ? d + "T00:00:00Z" : d), { dateStyle: "long", timeZone: d.length === 10 ? "UTC" : undefined });
  const yn = (v: boolean | null | undefined, yes: string, no: string) => (v === true ? yes : v === false ? no : t("notSaid"));
  const rows: Array<[string, string]> = [
    [t("kind"), s(`kinds.${L.kind}`)],
    [t("rent"), price ? `${price} ${L.rent?.period === "week" ? c("perWeek") : c("perMonth")}` : t("notSaid")],
    [t("deposit"), L.deposit_minor !== null && L.deposit_minor !== undefined ? (money(locale, L.deposit_minor, L.rent?.currency, exp) || t("notSaid")) : t("notSaid")],
    [t("bills"), yn(L.bills_included, c("billsIn"), c("billsOut"))],
    [s("furnished"), yn(L.furnished, s("yes"), s("no"))],
    [t("available"), L.available_from ? date(L.available_from) : t("notSaid")],
    [t("minStay"), L.min_stay_months ? t("months", { count: L.min_stay_months }) : t("notSaid")],
    [t("bedrooms"), L.bedrooms !== null && L.bedrooms !== undefined ? fmt.number(L.bedrooms) : t("notSaid")],
    [t("flatmates"), L.current_flatmates !== null && L.current_flatmates !== undefined ? fmt.number(L.current_flatmates) : t("notSaid")],
  ];
  if (L.total_area_m2) rows.push([t("area"), t("squareMeters", { value: fmt.number(Number(L.total_area_m2)) })]);
  if (L.room_area_m2) rows.push([t("roomArea"), t("squareMeters", { value: fmt.number(Number(L.room_area_m2)) })]);
  const rules = Object.entries(L.house_rules || {});
  return (
    <article className="mx-auto flex max-w-4xl flex-col gap-8">
      {back}
      {L.is_own && L.status !== "published" && <Notice>{t("preview", { status: t.has(`statuses.${L.status}`) ? t(`statuses.${L.status}`) : L.status })}</Notice>}
      <header className="flex items-start justify-between gap-4">
        <div className="flex flex-col gap-2">
          <p className="text-sm font-semibold uppercase tracking-wide text-ink-soft">{s(`kinds.${L.kind}`)}{place(L) ? ` · ${place(L)}` : ""}</p>
          <h1 className="text-3xl font-bold tracking-tight">{title}</h1>
          <p className="text-xl">{price ? <><span className="font-semibold ltr-island">{price}</span> <span className="text-ink-soft">{L.rent?.period === "week" ? c("perWeek") : c("perMonth")}</span></> : c("noRent")}</p>
        </div>
        {L.status === "published" && <FavouriteButton listingId={L.id} initial={!!L.is_favourite} title={title} />}
      </header>
      {r.data.warnings.includes("photos_unavailable") && <Notice>{s("warnings.photos_unavailable")}</Notice>}
      <section aria-labelledby="photos-title" className="flex flex-col gap-3">
        <h2 id="photos-title" className="sr-only">{t("photos")}</h2>
        {r.data.photos.length === 0 ? <p className="text-ink-soft">{c("noPhoto")}</p> : (
          <ul className="flex snap-x snap-mandatory gap-3 overflow-x-auto pb-2" tabIndex={0} aria-label={t("photos")}>
            {r.data.photos.map((p, i) => (
              <li key={p.media_id} className="w-[85%] shrink-0 snap-start sm:w-[60%]">
                <Photo src={p.url} alt={t("photoAlt", { n: i + 1, total: r.data.photos.length })} loading={i === 0 ? "eager" : "lazy"}
                  width={p.width || undefined} height={p.height || undefined} className="aspect-[4/3] w-full rounded-field object-cover"
                  fallback={c("noPhoto")} />
              </li>
            ))}
          </ul>
        )}
      </section>
      <div className="grid gap-8 md:grid-cols-[1.4fr_1fr]">
        <div className="flex flex-col gap-6">
          {L.description && (
            <section aria-labelledby="desc-title" className="flex flex-col gap-2">
              <h2 id="desc-title" className="text-xl font-semibold">{t("description")}</h2>
              <p className="whitespace-pre-line" lang={L.description_lang || undefined}>{L.description}</p>
            </section>
          )}
          <section aria-labelledby="amen-title" className="flex flex-col gap-2">
            <h2 id="amen-title" className="text-xl font-semibold">{t("amenities")}</h2>
            {(L.amenities || []).length === 0 ? <p className="text-ink-soft">{t("notSaid")}</p> : (
              <ul className="flex flex-wrap gap-2">
                {(L.amenities || []).map((x) => <li key={x} className="rounded-full border border-line bg-paper px-3 py-1 text-sm">{a.has(x) ? a(x) : x}</li>)}
              </ul>
            )}
          </section>
          <section aria-labelledby="rules-title" className="flex flex-col gap-2">
            <h2 id="rules-title" className="text-xl font-semibold">{t("houseRules")}</h2>
            {rules.length === 0 ? <p className="text-ink-soft">{t("noRules")}</p> : (
              <ul className="flex flex-col gap-1">
                {rules.map(([k, v]) => <li key={k}><span className="font-semibold">{s.has(`rules.${k}`) ? s(`rules.${k}`) : k}</span> · {v === "yes" ? s("allowed") : v === "no" ? s("notAllowed") : v}</li>)}
              </ul>
            )}
          </section>
        </div>
        <aside className="flex flex-col gap-4">
          <section aria-labelledby="details-title" className="rounded-field border border-line bg-paper p-4">
            <h2 id="details-title" className="mb-3 text-lg font-semibold">{t("details")}</h2>
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-[0.95rem]">
              {rows.map(([k, v]) => (<Fragment key={k}><dt className="text-ink-soft">{k}</dt><dd>{v}</dd></Fragment>))}
            </dl>
          </section>
          {place(L) && <p className="text-sm"><span className="font-semibold">{t("location")}</span> · {place(L)}. {t("approximate")}</p>}
          {L.published_at && <p className="text-sm text-ink-soft">{t("published", { date: date(L.published_at) })}</p>}
          {L.is_synthetic && <p className="text-sm text-ink-soft">{s("synthetic")}</p>}
          <p className="text-sm text-ink-soft">{t("contactSoon")}</p>
        </aside>
      </div>
    </article>
  );
}
