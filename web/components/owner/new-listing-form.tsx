"use client";
// /owner/new: the owner's text and the country. POST /v1/listings creates the draft; the next page asks for photos.
import { useActionState, useEffect, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { Field, Notice, Select, Textarea, describedBy } from "@/components/ui/field";
import { createListingAction, type OwnerState } from "@/lib/actions/owner";
import { knownIssue } from "@/lib/errors";

export function NewListingForm({ jurisdictions, defaultJurisdiction }:
  { jurisdictions: Array<{ code: string; name: string }>; defaultJurisdiction: string }) {
  const t = useTranslations("owner");
  const e = useTranslations("errors");
  const iss = useTranslations("issues");
  const countries = useTranslations("countries");
  const locale = useLocale();
  const [idem, setIdem] = useState("");
  const [state, action, pending] = useActionState<OwnerState, FormData>(createListingAction.bind(null, locale), {});
  useEffect(() => { setIdem(`listing-${crypto.randomUUID()}`); }, [state]);
  const err = (f: string) => (state.fields?.[f] ? iss(knownIssue(state.fields[f])) : null);
  return (
    <form action={action} className="flex flex-col gap-6">
      <input type="hidden" name="idem" value={idem} />
      <Field id="jurisdiction_code" label={t("country")} error={err("jurisdiction_code")}>
        <Select id="jurisdiction_code" name="jurisdiction_code" defaultValue={defaultJurisdiction}>
          {jurisdictions.map((j) => <option key={j.code} value={j.code}>{countries.has(j.code) ? countries(j.code) : j.name}</option>)}
        </Select>
      </Field>
      <Field id="text" label={t("text")} hint={t("textHint")} error={err("text")}>
        <Textarea id="text" name="text" required maxLength={4000} rows={7} aria-describedby={describedBy("text", true, err("text"))}
          aria-invalid={!!err("text")} />
      </Field>
      {state.error && !state.fields?.text && <Notice tone="error">{e.has(state.error) ? e(state.error) : e("INTERNAL")}</Notice>}
      <Button type="submit" disabled={pending || !idem} className="self-start">{t("create")}</Button>
    </form>
  );
}
