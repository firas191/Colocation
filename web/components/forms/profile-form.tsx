"use client";
// The lifestyle and search profile (PUT /v1/profiles/me). Values are kept in state so that the "one sentence"
// helper (POST /v1/profiles/extract) can fill them; nothing is saved until the person presses Save.
import { useActionState, useEffect, useState, startTransition } from "react";
import { useFormatter, useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { Choice, Field, Input, Notice, Select, Textarea, describedBy } from "@/components/ui/field";
import { extractProfileAction, saveProfileAction, type ActionState } from "@/lib/actions/platform";
import { knownIssue } from "@/lib/errors";

export interface Jurisdiction { code: string; name: string; currency: string; exponent: number }
export interface Profile {
  jurisdiction_code: string | null; budget_min_minor: number | null; budget_max_minor: number | null; currency: string | null;
  budget_period: string | null; anchor_label: string | null; move_in_from: string | null; min_stay_months: number | null;
  declared_preferences: Record<string, string>; languages: string[]; profile_version?: number; updated_at?: string;
}

const LANGS = ["ar", "aeb", "fr", "en", "de", "es", "it"];
const YESNO = ["smoking", "pets", "guests", "quiet_hours"] as const;

const mainUnits = (minor: number | null, exp: number) => (minor === null || minor === undefined ? "" : String(minor / 10 ** exp));

function toValues(p: Profile | null, fallbackJur: string, jurs: Jurisdiction[]) {
  const code = p?.jurisdiction_code || fallbackJur;
  const exp = jurs.find((j) => j.code === code)?.exponent ?? 2;
  return {
    jurisdiction_code: code,
    budget_min: mainUnits(p?.budget_min_minor ?? null, exp), budget_max: mainUnits(p?.budget_max_minor ?? null, exp),
    budget_period: p?.budget_period || "month", anchor_label: p?.anchor_label || "", move_in_from: p?.move_in_from || "",
    min_stay_months: p?.min_stay_months ? String(p.min_stay_months) : "",
    prefs: { ...(p?.declared_preferences || {}) } as Record<string, string>, languages: p?.languages || [],
  };
}

export function ProfileForm({ locale, profile, jurisdictions, defaultJurisdiction }:
  { locale: string; profile: Profile | null; jurisdictions: Jurisdiction[]; defaultJurisdiction: string }) {
  const t = useTranslations("profile");
  const e = useTranslations("errors");
  const iss = useTranslations("issues");
  const countries = useTranslations("countries");
  const fmt = useFormatter();
  const [values, setValues] = useState(() => toValues(profile, defaultJurisdiction, jurisdictions));
  const [formKey, setFormKey] = useState(0);           // remounts the uncontrolled radio groups after a fill
  const [idem, setIdem] = useState("");
  const [saved, save, saving] = useActionState<ActionState, FormData>(saveProfileAction.bind(null, locale), {});
  const [extracted, extract, extracting] = useActionState<ActionState, FormData>(extractProfileAction.bind(null, locale), {});

  useEffect(() => { setIdem(`profile-${crypto.randomUUID()}`); }, [saved]);
  useEffect(() => {
    if (extracted.ok && extracted.profile) {
      startTransition(() => {
        setValues((v) => ({ ...toValues({ ...(extracted.profile as unknown as Profile),
          jurisdiction_code: (extracted.profile!.jurisdiction_code as string) || v.jurisdiction_code }, v.jurisdiction_code, jurisdictions) }));
        setFormKey((k) => k + 1);
      });
    }
  }, [extracted, jurisdictions]);

  const jur = jurisdictions.find((j) => j.code === values.jurisdiction_code) || jurisdictions[0];
  const err = (f: string) => (saved.fields?.[f] ? iss(knownIssue(saved.fields[f])) : null);
  const set = (k: keyof typeof values) => (ev: { target: { value: string } }) => setValues({ ...values, [k]: ev.target.value });
  const yn = [{ value: "yes", label: t("yes") }, { value: "no", label: t("no") }, { value: "unset", label: t("unset") }];

  return (
    <div className="flex flex-col gap-10">
      <section aria-labelledby="quick-title" className="flex flex-col gap-3 panel p-5">
        <h2 id="quick-title" className="section-title">{t("quick.title")}</h2>
        <p className="max-w-prose text-sm text-ink-soft">{t("quick.hint")}</p>
        <form action={extract} className="flex flex-col gap-3">
          <input type="hidden" name="jurisdiction_code" value={values.jurisdiction_code} />
          <Textarea name="text" aria-label={t("quick.placeholder")} placeholder={t("quick.placeholder")} maxLength={2000} required rows={2} />
          <div className="flex flex-wrap items-center gap-4">
            <Button type="submit" variant="secondary" disabled={extracting}>{t("quick.submit")}</Button>
            {extracting && <p role="status" className="text-sm text-ink-soft">{t("quick.working")}</p>}
          </div>
          {!extracting && extracted.ok && <Notice tone="ok">{t("quick.done")}</Notice>}
          {!extracting && extracted.error && <Notice tone="error">{extracted.error === "EXTRACTION_FAILED" ? t("quick.notUnderstood") : (e.has(extracted.error) ? e(extracted.error) : e("INTERNAL"))}</Notice>}
        </form>
      </section>

      <form key={formKey} action={save} className="flex flex-col gap-10">
        <input type="hidden" name="idem" value={idem} />
        <input type="hidden" name="currency" value={jur?.currency || ""} />
        <input type="hidden" name="exponent" value={jur?.exponent ?? 2} />

        <fieldset className="grid gap-5 sm:grid-cols-2">
          <legend className="mb-4 text-xl font-semibold">{t("where")}</legend>
          <Field id="jurisdiction_code" label={t("country")} error={err("jurisdiction_code")}>
            <Select id="jurisdiction_code" name="jurisdiction_code" value={values.jurisdiction_code} onChange={set("jurisdiction_code")}>
              {jurisdictions.map((j) => <option key={j.code} value={j.code}>{countries.has(j.code) ? countries(j.code) : j.name}</option>)}
            </Select>
          </Field>
          <Field id="anchor_label" label={t("area")} hint={t("areaHint")} error={err("anchor_label")}>
            <Input id="anchor_label" name="anchor_label" value={values.anchor_label} onChange={set("anchor_label")} maxLength={120}
              aria-describedby={describedBy("anchor_label", true, err("anchor_label"))} />
          </Field>
          <Field id="move_in_from" label={t("moveIn")} error={err("move_in_from")}>
            <Input id="move_in_from" name="move_in_from" type="date" value={values.move_in_from} onChange={set("move_in_from")} />
          </Field>
          <Field id="min_stay_months" label={t("minStay")} error={err("min_stay_months")}>
            <Input id="min_stay_months" name="min_stay_months" type="number" inputMode="numeric" min={0} max={120}
              value={values.min_stay_months} onChange={set("min_stay_months")} />
          </Field>
        </fieldset>

        <fieldset className="grid gap-5 sm:grid-cols-3">
          <legend className="mb-4 text-xl font-semibold">{t("budget")} <span className="text-base font-normal text-ink-soft ltr-island">({jur?.currency})</span></legend>
          <Field id="budget_min" label={t("budgetMin")} error={err("budget_min_minor")}>
            <Input id="budget_min" name="budget_min" inputMode="decimal" value={values.budget_min} onChange={set("budget_min")} dir="ltr" />
          </Field>
          <Field id="budget_max" label={t("budgetMax")} error={err("budget_max_minor")}>
            <Input id="budget_max" name="budget_max" inputMode="decimal" value={values.budget_max} onChange={set("budget_max")} dir="ltr" />
          </Field>
          <Field id="budget_period" label={t("period")}>
            <Select id="budget_period" name="budget_period" value={values.budget_period} onChange={set("budget_period")}>
              <option value="month">{t("month")}</option><option value="week">{t("week")}</option>
            </Select>
          </Field>
        </fieldset>

        <fieldset className="flex flex-col gap-6">
          <legend className="mb-4 text-xl font-semibold">{t("life")}</legend>
          <div className="grid gap-6 sm:grid-cols-2">
            {YESNO.map((k) => <Choice key={k} name={k} legend={t(k)} options={yn} value={values.prefs[k] || "unset"} />)}
            <Choice name="schedule" legend={t("schedule")} value={values.prefs.schedule || "unset"}
              options={[...(["early", "late", "irregular"] as const).map((v) => ({ value: v, label: t(`scheduleOptions.${v}`) })), { value: "unset", label: t("unset") }]} />
            <Choice name="cleanliness" legend={t("cleanliness")} value={values.prefs.cleanliness || "unset"}
              options={[...(["high", "medium", "relaxed"] as const).map((v) => ({ value: v, label: t(`cleanlinessOptions.${v}`) })), { value: "unset", label: t("unset") }]} />
          </div>
          <fieldset className="flex flex-col gap-2">
            <legend className="mb-1.5 text-sm font-semibold">{t("languages")}</legend>
            <div className="flex flex-wrap gap-x-5 gap-y-2">
              {LANGS.map((l) => (
                <label key={l} className="flex min-h-10 items-center gap-2">
                  <input type="checkbox" name="languages" value={l} defaultChecked={values.languages.includes(l)} className="size-5 accent-door" />
                  {t(`languageNames.${l}`)}
                </label>
              ))}
            </div>
          </fieldset>
        </fieldset>

        <div className="flex flex-col gap-3">
          {saved.ok && <Notice tone="ok">{t("saved")}</Notice>}
          {saved.ok && saved.warnings?.map((w) => <Notice key={w}>{t.has(`warnings.${w}`) ? t(`warnings.${w}`) : w}</Notice>)}
          {saved.error && <Notice tone="error">{e.has(saved.error) ? e(saved.error) : e("INTERNAL")}</Notice>}
          <Button type="submit" disabled={saving || !idem} className="self-start">{t("submit")}</Button>
          {profile?.profile_version && profile.updated_at && (
            <p className="text-sm text-ink-soft">{t("version", { version: profile.profile_version, date: fmt.dateTime(new Date(profile.updated_at), { dateStyle: "medium" }) })}</p>
          )}
        </div>
      </form>
    </div>
  );
}
