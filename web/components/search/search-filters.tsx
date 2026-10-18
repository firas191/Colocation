// The search form. A plain GET form: the filters are the page's address, so a search can be bookmarked, shared and
// used without JavaScript. What the API refused comes back as field messages (422 details).
// Layout (D-116): one horizontal bar for what people set every time (words, place, budget, country), the main
// amenities as chips under it, and the rest folded in "More filters" (a filter column takes the room of the results).
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { Field, Input, Select } from "@/components/ui/field";
import { Link } from "@/i18n/navigation";
import { AMENITIES, KINDS, MAIN_AMENITIES, RULES } from "@/lib/listing";
import type { SearchForm } from "@/lib/search-query";

function ChipBox({ name, value, checked, label }: { name: string; value: string; checked: boolean; label: string }) {
  return (
    <label className="relative">
      <input type="checkbox" name={name} value={value} defaultChecked={checked} className="peer sr-only" />
      <span className="chip cursor-pointer transition-colors hover:border-door peer-checked:border-door peer-checked:bg-door-soft peer-checked:text-door
        peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-door peer-checked:[&>svg]:inline">
        <svg viewBox="0 0 12 12" aria-hidden="true" className="hidden size-3" fill="none" stroke="currentColor" strokeWidth="2"><path d="m2.5 6.5 2.5 2.5 4.5-5" /></svg>
        {label}
      </span>
    </label>
  );
}

export function SearchFilters({ f, countries, cities, currency, errors }:
  { f: SearchForm; countries: Array<{ code: string; label: string }>; cities: string[]; currency: string; errors: Record<string, string> }) {
  const t = useTranslations("search");
  const a = useTranslations("amenities");
  const iss = useTranslations("issues");
  const err = (k: string) => (errors[k] ? (iss.has(errors[k]) ? iss(errors[k]) : iss("type")) : null);
  const extra = AMENITIES.filter((x) => !(MAIN_AMENITIES as readonly string[]).includes(x));
  const tri = (name: string, label: string, value: string) => (
    <Field id={name} label={label} error={err(name === "bills" ? "bills_included" : name)}>
      <Select id={name} name={name} defaultValue={value}>
        <option value="">{t("any")}</option><option value="true">{t("yes")}</option><option value="false">{t("no")}</option>
      </Select>
    </Field>
  );
  const open = extra.some((x) => f.amenity.includes(x)) || Object.keys(f.rules).length > 0 || f.use_profile
    || !!f.near || !!f.kind || !!f.furnished || !!f.bills || !!f.available_by || Object.keys(errors).some((k) => !["q", "max_rent", "jurisdiction"].includes(k));
  return (
    <form method="get" action="" className="flex flex-col gap-4" role="search" aria-label={t("title")}>
      {f.view === "map" && <input type="hidden" name="view" value="map" />}
      <div className="panel grid gap-3 p-3 shadow-[var(--shadow-lift)] sm:grid-cols-2 lg:grid-cols-[1.4fr_1.2fr_1.1fr_0.9fr_auto] lg:items-end">
        <Field id="q" label={t("q")} error={err("q")}>
          <Input id="q" name="q" defaultValue={f.q} placeholder={t("qPlaceholder")} maxLength={300} />
        </Field>
        {/* the cities of the country chosen in the header (D-118) */}
        <Field id="city" label={t("city")} error={f.near ? null : err("near")}>
          <Select id="city" name="city" defaultValue={f.city}>
            <option value="">{t("allCities")}</option>
            {cities.map((c) => <option key={c} value={c}>{c}</option>)}
            {f.city && !cities.includes(f.city) && <option value={f.city}>{f.city}</option>}
          </Select>
        </Field>
        <Field id="max" label={<>{t("maxRent")} <span className="font-normal text-ink-soft ltr-island">({currency})</span></>} error={err("max_rent")}>
          <div className="flex gap-2">
            <Input id="max" name="max" defaultValue={f.max} inputMode="decimal" dir="ltr" className="min-w-0" />
            <Select name="period" defaultValue={f.period} aria-label={t("period")} className="w-auto">
              <option value="month">{t("month")}</option><option value="week">{t("week")}</option>
            </Select>
          </div>
        </Field>
        <input type="hidden" name="country" value={f.country} />
        <p className="flex flex-col gap-1.5 text-sm">
          <span className="font-semibold">{t("country")}</span>
          <span className="flex min-h-11 items-center rounded-field bg-raised px-3 text-ink-soft">{countries.find((c) => c.code === f.country)?.label || f.country}</span>
        </p>
        <Button type="submit" className="w-full lg:w-auto">{t("submit")}</Button>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <fieldset className="contents">
          <legend className="sr-only">{t("amenities")}</legend>
          {MAIN_AMENITIES.map((x) => <ChipBox key={x} name="amenity" value={x} checked={f.amenity.includes(x)} label={a(x)} />)}
        </fieldset>
        {err("amenities") && <p className="w-full text-sm text-brick" role="alert">{err("amenities")}</p>}
      </div>
      <details className="group" open={open}>
        <summary className="inline-flex min-h-9 cursor-pointer items-center gap-2 rounded-full px-1 text-sm font-semibold text-door">
          <svg viewBox="0 0 12 12" aria-hidden="true" className="size-3 transition-transform group-open:rotate-180" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M2.5 4.5 6 8l3.5-3.5" /></svg>
          {t("moreFilters")}
        </summary>
        <div className="panel mt-3 flex flex-col gap-5 p-4 sm:p-5">
          <Field id="near" label={t("nearPrecise")} error={f.near ? err("near") : null}>
            <Input id="near" name="near" defaultValue={f.near} placeholder={t("nearPlaceholder")} maxLength={120} />
          </Field>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Field id="kind" label={t("kind")} error={err("kind")}>
              <Select id="kind" name="kind" defaultValue={f.kind}>
                <option value="">{t("any")}</option>
                {KINDS.map((k) => <option key={k} value={k}>{t(`kinds.${k}`)}</option>)}
              </Select>
            </Field>
            {tri("furnished", t("furnished"), f.furnished)}
            {tri("bills", t("bills"), f.bills)}
            <Field id="available_by" label={t("availableBy")} error={err("available_by")}>
              <Input id="available_by" name="available_by" type="date" defaultValue={f.available_by} />
            </Field>
          </div>
          <fieldset className="flex flex-wrap gap-2">
            <legend className="mb-2 text-sm font-semibold">{t("amenities")}</legend>
            {extra.map((x) => <ChipBox key={x} name="amenity" value={x} checked={f.amenity.includes(x)} label={a(x)} />)}
          </fieldset>
          <fieldset className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <legend className="mb-2 text-sm font-semibold">{t("houseRules")}</legend>
            {RULES.map((r) => (
              <Field key={r} id={`rule_${r}`} label={t(`rules.${r}`)}>
                <Select id={`rule_${r}`} name={`rule_${r}`} defaultValue={f.rules[r] || ""}>
                  <option value="">{t("any")}</option><option value="yes">{t("allowed")}</option><option value="no">{t("notAllowed")}</option>
                </Select>
              </Field>
            ))}
          </fieldset>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" name="use_profile" value="true" defaultChecked={f.use_profile} className="size-5 accent-door" />{t("useProfile")}
          </label>
          <div className="flex flex-wrap items-center gap-4">
            <Button type="submit">{t("submit")}</Button>
            <Link href={f.view === "map" ? "/search?view=map" : "/search"} className="link-action">{t("reset")}</Link>
          </div>
        </div>
      </details>
    </form>
  );
}
