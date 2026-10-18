// /favourites (platform P2): GET /v1/me/favourites. A listing that is no longer published stays in the list, marked,
// so it can be removed.
import { getFormatter, getTranslations, setRequestLocale } from "next-intl/server";
import { Link } from "@/i18n/navigation";
import { Empty, Notice } from "@/components/ui/field";
import { ListingCard } from "@/components/listing/listing-card";
import { FavouriteButton } from "@/components/listing/favourite-button";
import { requireMember } from "@/lib/server/guard";
import { api } from "@/lib/server/api";
import { clientIp } from "@/lib/server/viewer";
import type { ListingCard as Card } from "@/lib/listing";

interface Item { id: number; listing_id: string; saved_at: string; available: boolean; listing: Card | null }

export async function generateMetadata() {
  const t = await getTranslations("favourites");
  return { title: t("title") };
}

export default async function Favourites({ params, searchParams }:
  { params: Promise<{ locale: string }>; searchParams: Promise<{ before?: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const me = await requireMember(locale);
  const { before } = await searchParams;
  const t = await getTranslations("favourites");
  const e = await getTranslations("errors");
  const fmt = await getFormatter();
  const r = await api<{ items: Item[]; next_before: number | null; total: number; warnings: string[] }>("GET", "/v1/me/favourites",
    { userId: me.user_id, clientIp: await clientIp(), query: { limit: 24, before: before && /^\d+$/.test(before) ? before : undefined } });
  if (!r.ok) return <Notice tone="error">{e.has(r.error.code) ? e(r.error.code) : e("INTERNAL")}</Notice>;
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <h1 className="page-title">{t("title")}</h1>
        <p className="text-ink-soft">{t("count", { count: r.data.total })}</p>
      </div>
      {r.data.items.length === 0 ? <Empty action={<Link href="/search" className="btn btn-primary">{(await getTranslations("nav"))("search")}</Link>}>{t("empty")}</Empty> : (
        <ul className="grid gap-x-5 gap-y-9 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {r.data.items.map((x) => (
            <li key={x.id} className="flex flex-col gap-1">
              {x.listing ? <ListingCard c={x.listing} /> : (
                <div className="flex items-center justify-between gap-3 rounded-field border border-dashed border-line bg-paper p-4">
                  <p className="text-ink-soft">{t("unavailable")}</p>
                  <FavouriteButton listingId={x.listing_id} initial={true} title={t("unavailable")} />
                </div>
              )}
              <p className="text-xs text-ink-soft">{t("savedOn", { date: fmt.dateTime(new Date(x.saved_at), { dateStyle: "medium" }) })}</p>
            </li>
          ))}
        </ul>
      )}
      {r.data.next_before && <Link href={{ pathname: "/favourites", query: { before: String(r.data.next_before) } }} className="btn btn-secondary self-start">{t("more")}</Link>}
    </div>
  );
}
