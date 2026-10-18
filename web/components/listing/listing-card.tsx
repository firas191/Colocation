// One listing in a list (search, favourites, the assistant's results): the photo first and large, then the price and
// the place, as on the best room sites; a few facts as chips; the heart on the photo. Everything shown comes from the
// API's card; nothing is computed here but the number format. `wide`: photo beside the text (the split map view).
import { clsx } from "clsx";
import { useFormatter, useLocale, useTranslations } from "next-intl";
import { Link } from "@/i18n/navigation";
import { FavouriteButton } from "./favourite-button";
import { Photo } from "./photo";
import { money, place, type ListingCard as Card } from "@/lib/listing";

export function ListingCard({ c, showFavourite = true, wide = false }: { c: Card; showFavourite?: boolean; wide?: boolean }) {
  const t = useTranslations("card");
  const s = useTranslations("search");
  const locale = useLocale();
  const fmt = useFormatter();
  const title = c.title || t("untitled");
  const price = c.rent ? money(locale, c.rent.amount_minor, c.rent.currency, c.rent.exponent ?? 2) : null;
  const where = place(c);
  const facts = [
    c.furnished === true ? t("furnished") : c.furnished === false ? t("unfurnished") : null,
    c.bills_included === true ? t("billsIn") : c.bills_included === false ? t("billsOut") : null,
    c.available_from ? t("availableFrom", { date: fmt.dateTime(new Date(c.available_from + "T00:00:00Z"), { dateStyle: "medium", timeZone: "UTC" }) }) : null,
  ].filter(Boolean) as string[];
  return (
    <article data-listing={c.id} className={clsx("group relative flex gap-4", wide ? "flex-row items-stretch" : "flex-col")}>
      <div className={clsx("relative shrink-0 overflow-hidden rounded-[var(--radius-photo)] bg-raised", wide ? "aspect-square w-36 sm:w-44" : "aspect-[4/3] w-full")}>
        {c.cover_photo ? (
          // processed copy (EXIF removed, faces and text blurred), signed for a short time by the API
          <Photo src={c.cover_photo.url} alt="" loading="lazy" className="size-full object-cover transition-transform duration-500 group-hover:scale-[1.03]" fallback={t("noPhoto")} />
        ) : (
          <div className="grid size-full place-items-center text-sm text-ink-soft">{t("noPhoto")}</div>
        )}
        {showFavourite && <FavouriteButton listingId={c.id} initial={!!c.is_favourite} title={title} className="absolute end-2.5 top-2.5 z-10" />}
        {!wide && <span className="absolute start-2.5 top-2.5 rounded-full bg-paper/90 px-2.5 py-1 text-xs font-semibold text-ink backdrop-blur">{s(`kinds.${c.kind}`)}</span>}
        {c.photo_count ? <span className="absolute bottom-2.5 end-2.5 rounded-full bg-ink/70 px-2 py-0.5 text-xs text-paper">{t("photos", { count: c.photo_count })}</span> : null}
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        {wide && <p className="text-xs font-semibold text-door">{s(`kinds.${c.kind}`)}</p>}
        <div className="flex items-start justify-between gap-3">
          <h3 className="min-w-0 text-[1.05rem] font-semibold leading-snug [overflow-wrap:anywhere]">
            <Link href={`/listings/${c.id}`} className="text-ink no-underline after:absolute after:inset-0 group-hover:text-door" aria-label={t("open", { title })}>
              {title}
            </Link>
          </h3>
        </div>
        {where && (
          <p className="text-sm text-ink-soft">
            {where}
            {typeof c.distance_m === "number" && <span className="ms-2 ltr-island">{t("distance", { km: fmt.number(c.distance_m / 1000, { maximumFractionDigits: 1 }) })}</span>}
          </p>
        )}
        <p className="mt-0.5">
          {price ? <><span className="font-[family-name:var(--font-display)] text-lg font-bold ltr-island">{price}</span>{" "}<span className="text-sm text-ink-soft">{c.rent?.period === "week" ? t("perWeek") : t("perMonth")}</span></>
            : <span className="text-ink-soft">{t("noRent")}</span>}
        </p>
        {facts.length > 0 && (
          <ul className="mt-1 flex flex-wrap gap-1.5">
            {facts.map((f) => <li key={f} className="rounded-full bg-raised px-2.5 py-0.5 text-xs text-ink">{f}</li>)}
          </ul>
        )}
        {c.is_synthetic && <p className="mt-auto pt-1 text-xs text-ink-soft">{s("synthetic")}</p>}
      </div>
    </article>
  );
}
