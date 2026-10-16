// /search (platform P2): GET /v2/search with the filters of the page's address, as a list or on the map.
import { getTranslations, setRequestLocale } from "next-intl/server";
import { Link } from "@/i18n/navigation";
import { Notice } from "@/components/ui/field";
import { ListingCard } from "@/components/listing/listing-card";
import { SearchFilters } from "@/components/search/search-filters";
import { SearchMap } from "@/components/search/search-map";
import { requireMember } from "@/lib/server/guard";
import { api } from "@/lib/server/api";
import { clientIp } from "@/lib/server/viewer";
import { fieldErrors, type Detail } from "@/lib/errors";
import { apiQuery, pageHref, readForm, type PageParams } from "@/lib/search-query";
import type { ListingCard as Card } from "@/lib/listing";

interface SearchData { mode: string; count: number; total_matching_filters: number; results: Card[]; warnings: string[];
  applied: { jurisdiction: string; center?: { lat: number; lng: number } | null } }

export async function generateMetadata() {
  const t = await getTranslations("search");
  return { title: t("title") };
}

export default async function Search({ params, searchParams }: { params: Promise<{ locale: string }>; searchParams: Promise<PageParams> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const me = await requireMember(locale);
  const t = await getTranslations("search");
  const e = await getTranslations("errors");
  const countries = await getTranslations("countries");
  const sp = await searchParams;
  // the account's country, else Tunisia (the first country of the plan), else the first one offered
  const has = (c: string | null) => !!c && me.jurisdictions.some((j) => j.code === c);
  const def = has(me.jurisdiction_code) ? me.jurisdiction_code! : has("TN") ? "TN" : (me.jurisdictions[0]?.code || "TN");
  const f = readForm(sp, def);
  const jur = me.jurisdictions.find((j) => j.code === f.country) || me.jurisdictions.find((j) => j.code === def);
  const r = await api<SearchData>("GET", "/v2/search", { userId: me.user_id, clientIp: await clientIp(), lang: locale,
    query: apiQuery(f, jur?.currency || "TND", jur?.exponent ?? 2) });
  const errors = !r.ok && r.error.code === "VALIDATION_FAILED" ? fieldErrors(r.error.details as Detail[]) : {};
  const list = me.jurisdictions.map((j) => ({ code: j.code, label: countries.has(j.code) ? countries(j.code) : j.name }));
  const next = r.ok ? (r.meta.next_cursor as string | null | undefined) || null : null;
  return (
    <div className="flex flex-col gap-8">
      <header className="flex flex-col gap-2">
        <h1 className="text-3xl font-bold tracking-tight">{t("title")}</h1>
        <p className="text-ink-soft">{t("lead")}</p>
      </header>
      <SearchFilters f={{ ...f, cursor: "" }} countries={list} currency={jur?.currency || ""} errors={errors} />
      <nav aria-label={t("view")} className="flex gap-2">
        {(["list", "map"] as const).map((v) => (
          <Link key={v} href={pageHref(f, { view: v, cursor: "", bbox: "" })} aria-current={f.view === v ? "page" : undefined}
            className={`inline-flex min-h-10 items-center rounded-full border px-4 text-sm no-underline ${f.view === v ? "border-door bg-door text-door-ink" : "border-line bg-paper text-ink"}`}>
            {v === "list" ? t("viewList") : t("viewMap")}
          </Link>
        ))}
      </nav>
      {!r.ok && r.error.code !== "VALIDATION_FAILED" && <Notice tone="error">{e.has(r.error.code) ? e(r.error.code) : e("INTERNAL")}</Notice>}
      {!r.ok && r.error.code === "VALIDATION_FAILED" && (
        (r.error.details as Detail[]).some((d) => d.field === "bbox" && d.issue === "too_large")
          // the map showed more than the API searches at once (max_degrees): say so instead of an empty page
          ? <Notice>{t("areaTooLarge")} <Link href={pageHref(f, { bbox: "", cursor: "" })}>{t("backToMap")}</Link></Notice>
          : <Notice tone="error">{e("VALIDATION_FAILED")}</Notice>
      )}
      {r.ok && (
        <section aria-labelledby="results-title" className="flex flex-col gap-5">
          <h2 id="results-title" className="text-xl font-semibold" aria-live="polite">{t("results", { count: r.data.total_matching_filters })}</h2>
          {r.data.warnings.map((w) => <Notice key={w}>{t.has(`warnings.${w}`) ? t(`warnings.${w}`) : w}</Notice>)}
          {f.view === "map" && (
            <SearchMap locale={locale} country={f.country} bbox={f.bbox} center={r.data.applied.center || null}
              points={r.data.results.filter((c) => c.public_location).map((c) => ({ id: c.id, title: c.title || "", ...c.public_location! }))}
              baseHref={pageHref(f, { bbox: "", cursor: "" })} />
          )}
          {r.data.results.length === 0 ? <p className="text-ink-soft">{t("noResults")}</p> : (
            <ul className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
              {r.data.results.map((c) => <li key={c.id}><ListingCard c={c} /></li>)}
            </ul>
          )}
          <div className="flex flex-wrap gap-5">
            {f.cursor && <Link href={pageHref(f, { cursor: "" })}>{t("first")}</Link>}
            {next && <Link href={pageHref(f, { cursor: next })} rel="next">{t("next")}</Link>}
          </div>
          <p className="text-xs text-ink-soft">{t("attribution")}</p>
        </section>
      )}
    </div>
  );
}
