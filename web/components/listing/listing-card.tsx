// One listing in a list (search, favourites, the assistant's results): cover photo, price, place, a few facts and
// the heart. Everything shown comes from the API's card; nothing is computed here but the number format.
import { useFormatter, useLocale, useTranslations } from "next-intl";
import { Link } from "@/i18n/navigation";
import { FavouriteButton } from "./favourite-button";
import { Photo } from "./photo";
import { money, place, type ListingCard as Card } from "@/lib/listing";

export function ListingCard({ c, showFavourite = true }: { c: Card; showFavourite?: boolean }) {
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
    <article className="group relative flex flex-col overflow-hidden rounded-field border border-line bg-paper">
      <div className="relative aspect-[4/3] bg-plaster">
        {c.cover_photo ? (
          // processed copy (EXIF removed, faces and text blurred), signed for a short time by the API
          <Photo src={c.cover_photo.url} alt="" loading="lazy" className="size-full object-cover" fallback={t("noPhoto")} />
        ) : (
          <div className="grid size-full place-items-center text-sm text-ink-soft">{t("noPhoto")}</div>
        )}
        {showFavourite && <FavouriteButton listingId={c.id} initial={!!c.is_favourite} title={title} className="absolute end-2 top-2 z-10" />}
        {c.photo_count ? <span className="absolute bottom-2 start-2 rounded-full bg-ink/75 px-2 py-0.5 text-xs text-paper">{t("photos", { count: c.photo_count })}</span> : null}
      </div>
      <div className="flex flex-1 flex-col gap-1.5 p-4">
        <p className="text-xs font-semibold uppercase tracking-wide text-ink-soft">{s(`kinds.${c.kind}`)}</p>
        <h3 className="text-lg font-semibold leading-snug">
          <Link href={`/listings/${c.id}`} className="text-ink no-underline after:absolute after:inset-0 hover:text-door" aria-label={t("open", { title })}>
            {title}
          </Link>
        </h3>
        <p className="text-base">
          {price ? <><span className="font-semibold ltr-island">{price}</span>{" "}<span className="text-ink-soft">{c.rent?.period === "week" ? t("perWeek") : t("perMonth")}</span></>
            : <span className="text-ink-soft">{t("noRent")}</span>}
        </p>
        {where && <p className="text-sm text-ink-soft">{where}{typeof c.distance_m === "number" ? ` · ${t("distance", { km: fmt.number(c.distance_m / 1000, { maximumFractionDigits: 1 }) })}` : ""}</p>}
        {facts.length > 0 && <p className="text-sm">{facts.join(" · ")}</p>}
        {c.is_synthetic && <p className="mt-auto pt-1 text-xs text-ink-soft">{s("synthetic")}</p>}
      </div>
    </article>
  );
}
