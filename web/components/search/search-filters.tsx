// The search form. A plain GET form: the filters are the page's address, so a search can be bookmarked, shared and
// used without JavaScript. What the API refused comes back as field messages (422 details).
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { Field, Input, Select } from "@/components/ui/field";
import { Link } from "@/i18n/navigation";
import { AMENITIES, KINDS, MAIN_AMENITIES, RULES } from "@/lib/listing";
import type { SearchForm } from "@/lib/search-query";

export function SearchFilters({ f, countries, currency, errors }:
  { f: SearchForm; countries: Array<{ code: string; label: string }>; currency: string; errors: Record<string, string> }) {
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
  const form = (
    <form method="get" action="" className="flex flex-col gap-5 rounded-field border border-line bg-paper p-4 sm:p-5" role="search" aria-label={t("title")}>
      {f.view === "map" && <input type="hidden" name="view" value="map" />}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Field id="q" label={t("q")} error={err("q")}>
          <Input id="q" name="q" defaultValue={f.q} placeholder={t("qPlaceholder")} maxLength={300} />
        </Field>
        <Field id="near" label={t("near")} error={err("near")}>
          <Input id="near" name="near" defaultValue={f.near} placeholder={t("nearPlaceholder")} maxLength={120} />
        </Field>
        <Field id="max" label={<>{t("maxRent")} <span className="font-normal text-ink-soft ltr-island">({currency})</span></>} error={err("max_rent")}>
          <div className="flex gap-2">
            <Input id="max" name="max" defaultValue={f.max} inputMode="decimal" dir="ltr" className="min-w-0" />
            <Select name="period" defaultValue={f.period} aria-label={t("period")} className="w-auto">
              <option value="month">{t("month")}</option><option value="week">{t("week")}</option>
            </Select>
          </div>
        </Field>
        <Field id="country" label={t("country")} error={err("jurisdiction")}>
          <Select id="country" name="country" defaultValue={f.country}>
            {countries.map((c) => <option key={c.code} value={c.code}>{c.label}</option>)}
          </Select>
        </Field>
      </div>
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
      <fieldset>
        <legend className="mb-2 text-sm font-semibold">{t("amenities")}</legend>
        <div className="flex flex-wrap gap-x-5 gap-y-2">
          {MAIN_AMENITIES.map((x) => (
            <label key={x} className="flex min-h-9 items-center gap-2 text-sm">
              <input type="checkbox" name="amenity" value={x} defaultChecked={f.amenity.includes(x)} className="size-5 accent-door" />{a(x)}
            </label>
          ))}
        </div>
        {err("amenities") && <p className="mt-1 text-sm text-brick" role="alert">{err("amenities")}</p>}
      </fieldset>
      <details className="group" open={extra.some((x) => f.amenity.includes(x)) || Object.keys(f.rules).length > 0 || f.use_profile}>
        <summary className="cursor-pointer text-sm font-semibold text-door">{t("moreFilters")}</summary>
        <div className="mt-4 flex flex-col gap-5">
          <div className="flex flex-wrap gap-x-5 gap-y-2">
            {extra.map((x) => (
              <label key={x} className="flex min-h-9 items-center gap-2 text-sm">
                <input type="checkbox" name="amenity" value={x} defaultChecked={f.amenity.includes(x)} className="size-5 accent-door" />{a(x)}
              </label>
            ))}
          </div>
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
        </div>
      </details>
      <div className="flex flex-wrap items-center gap-4">
        <Button type="submit">{t("submit")}</Button>
        <Link href={f.view === "map" ? "/search?view=map" : "/search"}>{t("reset")}</Link>
      </div>
    </form>
  );
  // On the map the filters fold away, so the map is in view on a phone; a refused filter keeps them open.
  if (f.view !== "map") return form;
  return (
    <details open={Object.keys(errors).length > 0} className="flex flex-col gap-3">
      <summary className="inline-flex min-h-10 cursor-pointer items-center rounded-full border border-line bg-paper px-4 text-sm font-semibold text-door">
        {t("filters")}
      </summary>
      <div className="mt-3">{form}</div>
    </details>
  );
}
