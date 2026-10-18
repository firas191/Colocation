"use client";
// "Check what we understood" (platform P3): the fields as the analysis (or the owner) left them. Only the fields the
// owner changes are sent, to PATCH /v1/listings/{id}; the API checks them (plausible rent, place on the map, amenity
// vocabulary) and its 422 details are shown next to the fields.
import { useActionState, useEffect, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { useRouter } from "@/i18n/navigation";
import { Button } from "@/components/ui/button";
import { Field, Input, Notice, Select, describedBy } from "@/components/ui/field";
import { saveListingAction, type OwnerState } from "@/lib/actions/owner";
import { knownIssue, type Detail } from "@/lib/errors";
import { AMENITIES, RULES } from "@/lib/listing";

export interface ReviewValues {
  rent: string; rent_period: string; deposit: string; bills_included: string; furnished: string; available_from: string;
  bedrooms: string; min_stay_months: string; place: string; amenities: string[]; rules: Record<string, string>;
}

export function ReviewForm({ listingId, values, currency }: { listingId: string; values: ReviewValues; currency: string }) {
  const t = useTranslations("owner");
  const e = useTranslations("errors");
  const iss = useTranslations("issues");
  const a = useTranslations("amenities");
  const s = useTranslations("search");
  const locale = useLocale();
  const router = useRouter();
  const [idem, setIdem] = useState("");
  const [state, action, pending] = useActionState<OwnerState, FormData>(saveListingAction.bind(null, locale, listingId), {});
  useEffect(() => { setIdem(`patch-${crypto.randomUUID()}`); if (state.ok) router.refresh(); }, [state, router]);

  // a field's message: the API's issue with its numbers when there is one (fieldIssues), else the generic text
  const err = (f: string): string | null => {
    const issue = state.fields?.[f];
    if (!issue) return null;
    const d = ((state.details || []) as Array<Detail & Record<string, unknown>>).find((x) => (x.field || "").split(".")[0] === f
      || (f === "amenities" && (x.field || "").startsWith("amenities")));
    if (t.has(`fieldIssues.${issue}`)) {
      return t(`fieldIssues.${issue}`, { min: String(d?.min ?? ""), max: String(d?.max ?? ""), currency: String(d?.currency ?? currency),
        candidates: Array.isArray(d?.candidates) ? (d!.candidates as string[]).join(", ") : "" });
    }
    return iss(knownIssue(issue));
  };
  const yn = (name: keyof ReviewValues, label: string) => (
    <Field id={name} label={label} error={err(name)}>
      <Select id={name} name={name} defaultValue={values[name] as string} aria-invalid={!!err(name)} aria-describedby={describedBy(name, false, err(name))}>
        <option value="">{t("notSaid")}</option>
        <option value="true">{t("yes")}</option>
        <option value="false">{t("no")}</option>
      </Select>
    </Field>
  );
  const num = (name: keyof ReviewValues, label: string, hint?: string, mode: "decimal" | "numeric" = "numeric") => (
    <Field id={name} label={label} hint={hint} error={err(name)}>
      <Input id={name} name={name} defaultValue={values[name] as string} inputMode={mode} autoComplete="off"
        aria-invalid={!!err(name)} aria-describedby={describedBy(name, hint, err(name))} className="ltr-island" />
    </Field>
  );
  const general = state.error && !Object.keys(state.fields || {}).length;
  return (
    <form action={action} className="flex flex-col gap-6" noValidate>
      <input type="hidden" name="idem" value={idem} />
      {(["rent", "rent_period", "deposit", "bills_included", "furnished", "available_from", "bedrooms", "min_stay_months", "place"] as const)
        .map((k) => <input key={k} type="hidden" name={`was_${k}`} value={values[k] as string} />)}
      <input type="hidden" name="was_amenities" value={values.amenities.join(",")} />
      {RULES.map((k) => <input key={k} type="hidden" name={`was_rule_${k}`} value={values.rules[k] || ""} />)}

      <div className="grid gap-5 sm:grid-cols-2">
        {num("rent", `${t("fields.rent")} (${t("inCurrency", { currency })})`, undefined, "decimal")}
        <Field id="rent_period" label={t("fields.rent_period")}>
          <Select id="rent_period" name="rent_period" defaultValue={values.rent_period || "month"}>
            <option value="month">{t("period.month")}</option>
            <option value="week">{t("period.week")}</option>
          </Select>
        </Field>
        {num("deposit", `${t("fields.deposit")} (${t("inCurrency", { currency })})`, undefined, "decimal")}
        {yn("bills_included", t("fields.bills_included"))}
        {yn("furnished", t("fields.furnished"))}
        <Field id="available_from" label={t("fields.available_from")} error={err("available_from")}>
          <Input id="available_from" name="available_from" type="date" defaultValue={values.available_from}
            aria-invalid={!!err("available_from")} aria-describedby={describedBy("available_from", false, err("available_from"))} />
        </Field>
        {num("bedrooms", t("fields.bedrooms"))}
        {num("min_stay_months", t("fields.min_stay_months"))}
      </div>
      <Field id="place" label={t("fields.place")} hint={t("placeHint")} error={err("place")}>
        <Input id="place" name="place" defaultValue={values.place} autoComplete="off" maxLength={120}
          aria-invalid={!!err("place")} aria-describedby={describedBy("place", true, err("place"))} />
      </Field>

      <fieldset className="flex flex-col gap-2" aria-describedby={err("amenities") ? "amenities-error" : undefined}>
        <legend className="mb-1.5 text-sm font-semibold">{t("fields.amenities")}</legend>
        <div className="flex flex-wrap gap-2">
          {AMENITIES.map((x) => (
            <label key={x} className="relative">
              <input type="checkbox" name="amenities" value={x} defaultChecked={values.amenities.includes(x)} className="peer sr-only" />
              <span className="chip cursor-pointer transition-colors hover:border-door peer-checked:border-door peer-checked:bg-door-soft peer-checked:text-door
                peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-door">{a.has(x) ? a(x) : x}</span>
            </label>
          ))}
        </div>
        {err("amenities") && <p id="amenities-error" role="alert" className="text-sm font-medium text-brick">{err("amenities")}</p>}
      </fieldset>

      <fieldset className="flex flex-col gap-3">
        <legend className="mb-1.5 text-sm font-semibold">{t("fields.house_rules")}</legend>
        <div className="grid gap-4 sm:grid-cols-2">
          {RULES.map((k) => (
            <Field key={k} id={`rule_${k}`} label={s.has(`rules.${k}`) ? s(`rules.${k}`) : k}>
              <Select id={`rule_${k}`} name={`rule_${k}`} defaultValue={values.rules[k] || ""}>
                <option value="">{t("notSaid")}</option>
                <option value="yes">{t("allowed")}</option>
                <option value="no">{t("notAllowed")}</option>
              </Select>
            </Field>
          ))}
        </div>
      </fieldset>

      {general && <Notice tone="error">{e.has(state.error!) ? e(state.error!) : e("INTERNAL")}</Notice>}
      {!pending && state.ok && <Notice tone="ok">{state.changed && state.changed.length ? t("saved") : t("nothingChanged")}</Notice>}
      <Button type="submit" disabled={pending || !idem} className="self-start">{t("save")}</Button>
    </form>
  );
}
