// /search (platform P2): GET /v2/search with the filters of the page's address, as a list or on the map.
import { getTranslations, setRequestLocale } from "next-intl/server";
import { Link } from "@/i18n/navigation";
import { Check, Field, Input, Notice } from "@/components/ui/field";
import { FormAction } from "@/components/home/form-action";
import { ListingCard } from "@/components/listing/listing-card";
import { SearchFilters } from "@/components/search/search-filters";
import { SearchMap } from "@/components/search/search-map";
import { currentCountry } from "@/lib/server/country";
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
  // the country chosen in the header (D-118); an address with ?country= (a shared link) keeps its own
  const def = await currentCountry(me);
  const f = readForm(sp, def);
  const jur = me.jurisdictions.find((j) => j.code === f.country) || me.jurisdictions.find((j) => j.code === def);
  const query = apiQuery(f, jur?.currency || "TND", jur?.exponent ?? 2);
  const ip = await clientIp();
  const [r, pl] = await Promise.all([
    api<SearchData>("GET", "/v2/search", { userId: me.user_id, clientIp: ip, lang: locale, query }),
    api<{ items: Array<{ place_key: string; name: string }> }>("GET", "/v1/places", { userId: me.user_id, clientIp: ip,
      query: { jurisdiction: f.country, kind: "city", lang: ["fr", "en", "ar"].includes(locale) ? locale : "fr" } }),
  ]);
  const cities = pl.ok ? pl.data.items.map((x) => x.name) : [];
  // what a saved search keeps (P7): the filters, without the page, the map area or the profile defaults
  const saved = Object.fromEntries(Object.entries(query).filter(([k]) => !["limit", "cursor", "ids", "use_profile", "bbox"].includes(k)));
  const errors = !r.ok && r.error.code === "VALIDATION_FAILED" ? fieldErrors(r.error.details as Detail[]) : {};
  const list = me.jurisdictions.map((j) => ({ code: j.code, label: countries.has(j.code) ? countries(j.code) : j.name }));
  const next = r.ok ? (r.meta.next_cursor as string | null | undefined) || null : null;
  const pins = r.ok ? r.data.results.filter((c) => c.public_location).map((c) => ({ id: c.id, title: c.title || "", ...c.public_location! })) : [];
  const split = f.view === "map";
  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-2">
        <h1 className="page-title">{t("title")}</h1>
        <p className="max-w-[65ch] text-ink-soft">{t("lead")}</p>
      </header>
      <SearchFilters f={{ ...f, cursor: "" }} countries={list} cities={cities} currency={jur?.currency || ""} errors={errors} />
      {!r.ok && r.error.code !== "VALIDATION_FAILED" && <Notice tone="error">{e.has(r.error.code) ? e(r.error.code) : e("INTERNAL")}</Notice>}
      {!r.ok && r.error.code === "VALIDATION_FAILED" && (
        (r.error.details as Detail[]).some((d) => d.field === "bbox" && d.issue === "too_large")
          // the map showed more than the API searches at once (max_degrees): say so instead of an empty page
          ? <Notice>{t("areaTooLarge")} <Link href={pageHref(f, { bbox: "", cursor: "" })} className="link-action">{t("backToMap")}</Link></Notice>
          : <Notice tone="error">{e("VALIDATION_FAILED")}</Notice>
      )}
      {r.ok && (
        <section aria-labelledby="results-title" className="flex flex-col gap-5">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line pb-4">
            <h2 id="results-title" className="section-title" aria-live="polite">{t("results", { count: r.data.total_matching_filters })}</h2>
            <nav aria-label={t("view")} className="inline-flex rounded-full border border-line bg-paper p-1">
              {(["list", "map"] as const).map((v) => (
                <Link key={v} href={pageHref(f, { view: v, cursor: "", bbox: "" })} aria-current={f.view === v ? "page" : undefined}
                  className={`inline-flex min-h-9 items-center gap-2 rounded-full px-4 text-sm font-semibold no-underline transition-colors ${f.view === v ? "bg-door text-door-ink" : "text-ink hover:bg-raised"}`}>
                  <svg viewBox="0 0 16 16" aria-hidden="true" className="size-4" fill="none" stroke="currentColor" strokeWidth="1.6">
                    {v === "list" ? <path d="M2.5 4h11M2.5 8h11M2.5 12h11" /> : <path d="M1.5 3.5 5.5 2l5 1.5 4-1.5v10.5l-4 1.5-5-1.5-4 1.5zM5.5 2v10.5M10.5 3.5V14" />}
                  </svg>
                  {v === "list" ? t("viewList") : t("viewMap")}
                </Link>
              ))}
            </nav>
          </div>
          {r.data.warnings.map((w) => <Notice key={w}>{t.has(`warnings.${w}`) ? t(`warnings.${w}`) : w}</Notice>)}
          <div className={split ? "grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)]" : ""}>
            {split && (
              <SearchMap locale={locale} country={f.country} bbox={f.bbox} center={r.data.applied.center || null} points={pins}
                baseHref={pageHref(f, { bbox: "", cursor: "" })}
                className="lg:sticky lg:top-20 lg:order-last lg:h-[calc(100dvh-6.5rem)]" />
            )}
            <div className="flex flex-col gap-6">
              {r.data.results.length === 0 ? <p className="text-ink-soft">{t("noResults")}</p> : (
                <ul className={split ? "flex flex-col gap-5" : "grid gap-x-5 gap-y-9 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4"}>
                  {r.data.results.map((c) => <li key={c.id}><ListingCard c={c} wide={split} /></li>)}
                </ul>
              )}
              <div className="flex flex-wrap gap-3">
                {f.cursor && <Link href={pageHref(f, { cursor: "" })} className="btn btn-secondary">{t("first")}</Link>}
                {next && <Link href={pageHref(f, { cursor: next })} rel="next" className="btn btn-secondary">{t("next")}</Link>}
              </div>
              <details className="panel group p-4">
                <summary className="flex cursor-pointer items-center justify-between gap-3 font-semibold">
                  <span className="flex items-center gap-2">
                    <svg viewBox="0 0 24 24" aria-hidden="true" className="size-5 text-bougain" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M6 9a6 6 0 1 1 12 0c0 6 2.5 7.5 2.5 7.5h-17S6 15 6 9Z" /><path d="M10 20a2 2 0 0 0 4 0" />
                    </svg>
                    {t("saveSearch")}
                  </span>
                  <svg viewBox="0 0 12 12" aria-hidden="true" className="size-3 transition-transform group-open:rotate-180" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M2.5 4.5 6 8l3.5-3.5" /></svg>
                </summary>
                <div className="mt-4">
                  <FormAction path="/v1/me/saved-searches" kind="savedSearch" submit={t("saveSearchSubmit")} done={t("saveSearchDone")}>
                    <input type="hidden" name="query" value={JSON.stringify(saved)} />
                    <Field id="ss-name" label={t("saveSearchName")}><Input id="ss-name" name="name" required maxLength={60} defaultValue={(f.q || f.near || f.country).slice(0, 60)} /></Field>
                    <Check id="ss-alert" name="alert" label={t("saveSearchAlert")} defaultChecked />
                  </FormAction>
                </div>
              </details>
              <p className="text-xs text-ink-soft">{t("attribution")}</p>
            </div>
          </div>
        </section>
      )}
    </div>
  );
}
