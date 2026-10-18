// /listings/[id] (platform P2): GET /v1/listings/{id}/public. Photos are the processed copies, as signed URLs; the
// place is the neighbourhood and an approximate point, never the address.
import { getFormatter, getTranslations, setRequestLocale } from "next-intl/server";
import { Link } from "@/i18n/navigation";
import { Notice } from "@/components/ui/field";
import { FavouriteButton } from "@/components/listing/favourite-button";
import { ListingContact, type Slot } from "@/components/contact/listing-contact";
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
  const back = <Link href="/search" className="link-back">{t("back")}</Link>;
  if (!r.ok) {
    return (
      <div className="mx-auto flex max-w-3xl flex-col gap-6">
        {back}
        <Notice tone={r.status === 404 ? "info" : "error"}>{r.status === 404 ? t("notFound") : (e.has(r.error.code) ? e(r.error.code) : e("INTERNAL"))}</Notice>
      </div>
    );
  }
  const L = r.data.listing;
  // the owner's visit times (platform P4); a failure only leaves the list empty
  const sl = L.status === "published" && !L.is_own
    ? await api<{ items: Slot[] }>("GET", `/v1/listings/${encodeURIComponent(id)}/visit-slots`, { userId: me.user_id, clientIp: await clientIp() }) : null;
  const slots = sl && sl.ok ? sl.data.items : [];
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
  const photos = r.data.photos;
  const ph = (p: Data["photos"][number], i: number, cls: string) => (
    <Photo src={p.url} alt={t("photoAlt", { n: i + 1, total: photos.length })} loading={i < 3 ? "eager" : "lazy"}
      width={p.width || undefined} height={p.height || undefined} className={`size-full object-cover ${cls}`} fallback={c("noPhoto")} />
  );
  const per = L.rent?.period === "week" ? c("perWeek") : c("perMonth");
  const facts = [
    L.furnished === true ? c("furnished") : L.furnished === false ? c("unfurnished") : null,
    L.bills_included === true ? c("billsIn") : L.bills_included === false ? c("billsOut") : null,
    L.available_from ? c("availableFrom", { date: date(L.available_from) }) : null,
  ].filter(Boolean) as string[];
  return (
    <article className="flex flex-col gap-8">
      <div className="text-sm">{back}</div>
      {L.is_own && L.status !== "published" && <Notice>{t("preview", { status: t.has(`statuses.${L.status}`) ? t(`statuses.${L.status}`) : L.status })}</Notice>}
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div className="flex min-w-0 flex-col gap-3">
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span className="chip border-door/40 bg-door-soft font-semibold text-door">{s(`kinds.${L.kind}`)}</span>
            {place(L) && <span className="text-ink-soft">{place(L)}</span>}
          </div>
          <h1 className="page-title max-w-[28ch]">{title}</h1>
        </div>
        {L.status === "published" && <FavouriteButton listingId={L.id} initial={!!L.is_favourite} title={title} />}
      </header>
      {r.data.warnings.includes("photos_unavailable") && <Notice>{s("warnings.photos_unavailable")}</Notice>}
      <section aria-labelledby="photos-title" className="flex flex-col gap-3">
        <h2 id="photos-title" className="sr-only">{t("photos")}</h2>
        {photos.length === 0 ? (
          <div className="grid aspect-[21/9] place-items-center rounded-[var(--radius-photo)] bg-raised text-ink-soft">{c("noPhoto")}</div>
        ) : photos.length === 1 ? (
          <div className="aspect-[16/9] overflow-hidden rounded-[var(--radius-photo)] bg-raised">{ph(photos[0], 0, "")}</div>
        ) : (
          <>
            {/* the first photo large, up to four beside it (as on the best room sites); any more in a strip below */}
            <ul className={`grid gap-2 overflow-hidden rounded-[var(--radius-photo)] sm:h-[min(62vh,34rem)] ${photos.length === 2 ? "sm:grid-cols-2" : "sm:grid-cols-4 sm:grid-rows-2"}`}
              aria-label={t("photos")}>
              {photos.slice(0, 5).map((p, i) => (
                <li key={p.media_id} className={`aspect-[4/3] overflow-hidden bg-raised sm:aspect-auto ${photos.length > 2 && i === 0 ? "sm:col-span-2 sm:row-span-2" : ""}
                  ${photos.length === 3 && i > 0 ? "sm:col-span-2" : ""} ${photos.length === 4 && i === 3 ? "sm:col-span-2" : ""}`}>
                  {ph(p, i, "transition-transform duration-500 hover:scale-[1.02]")}
                </li>
              ))}
            </ul>
            {photos.length > 5 && (
              <ul className="flex snap-x gap-2 overflow-x-auto pb-1" tabIndex={0} aria-label={t("photos")}>
                {photos.slice(5).map((p, i) => (
                  <li key={p.media_id} className="aspect-[4/3] w-48 shrink-0 snap-start overflow-hidden rounded-field bg-raised">{ph(p, i + 5, "")}</li>
                ))}
              </ul>
            )}
          </>
        )}
      </section>
      <div className="grid gap-10 lg:grid-cols-[minmax(0,1fr)_24rem]">
        <div className="flex flex-col gap-10">
          {facts.length > 0 && (
            <ul className="flex flex-wrap gap-2">{facts.map((x) => <li key={x} className="chip">{x}</li>)}</ul>
          )}
          {L.description && (
            <section aria-labelledby="desc-title" className="flex flex-col gap-3">
              <h2 id="desc-title" className="section-title">{t("description")}</h2>
              <p className="max-w-[70ch] whitespace-pre-line text-[1.05rem] leading-relaxed" lang={L.description_lang || undefined}>{L.description}</p>
            </section>
          )}
          <section aria-labelledby="details-title" className="flex flex-col gap-3">
            <h2 id="details-title" className="section-title">{t("details")}</h2>
            <dl className="grid grid-cols-2 gap-px overflow-hidden rounded-panel border border-line bg-line sm:grid-cols-3">
              {rows.map(([k, v]) => (
                <div key={k} className="flex flex-col gap-1 bg-paper p-4">
                  <dt className="text-sm text-ink-soft">{k}</dt><dd className="font-semibold">{v}</dd>
                </div>
              ))}
            </dl>
          </section>
          <section aria-labelledby="amen-title" className="flex flex-col gap-3">
            <h2 id="amen-title" className="section-title">{t("amenities")}</h2>
            {(L.amenities || []).length === 0 ? <p className="text-ink-soft">{t("notSaid")}</p> : (
              <ul className="flex flex-wrap gap-2">
                {(L.amenities || []).map((x) => (
                  <li key={x} className="chip"><span aria-hidden="true" className="size-1.5 rounded-full bg-door" />{a.has(x) ? a(x) : x}</li>
                ))}
              </ul>
            )}
          </section>
          <section aria-labelledby="rules-title" className="flex flex-col gap-3">
            <h2 id="rules-title" className="section-title">{t("houseRules")}</h2>
            {rules.length === 0 ? <p className="text-ink-soft">{t("noRules")}</p> : (
              <ul className="grid gap-2 sm:grid-cols-2">
                {rules.map(([k, v]) => (
                  <li key={k} className="flex items-center justify-between gap-3 rounded-field bg-raised px-4 py-3">
                    <span className="font-semibold">{s.has(`rules.${k}`) ? s(`rules.${k}`) : k}</span>
                    <span className={v === "no" ? "text-brick" : v === "yes" ? "text-olive" : "text-ink-soft"}>{v === "yes" ? s("allowed") : v === "no" ? s("notAllowed") : v}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>
          {place(L) && (
            <section aria-labelledby="where-title" className="flex flex-col gap-2">
              <h2 id="where-title" className="section-title">{t("location")}</h2>
              <p>{place(L)}. <span className="text-ink-soft">{t("approximate")}</span></p>
            </section>
          )}
        </div>
        <aside className="lg:sticky lg:top-20 lg:self-start">
          <div className="panel flex flex-col gap-5 p-5 shadow-[var(--shadow-lift)]">
            <p>
              {price ? <><span className="font-[family-name:var(--font-display)] text-3xl font-bold ltr-island">{price}</span> <span className="text-ink-soft">{per}</span></>
                : <span className="text-ink-soft">{c("noRent")}</span>}
            </p>
            {L.status === "published" && !L.is_own && <ListingContact listingId={L.id} slots={slots} />}
            {L.is_own && <Link href={`/owner/listings/${L.id}`} className="btn btn-primary">{(await getTranslations("owner"))("manage")}</Link>}
            <div className="flex flex-col gap-1 border-t border-line pt-4 text-sm text-ink-soft">
              {L.published_at && <p>{t("published", { date: date(L.published_at) })}</p>}
              {L.is_synthetic && <p>{s("synthetic")}</p>}
            </div>
          </div>
        </aside>
      </div>
    </article>
  );
}
