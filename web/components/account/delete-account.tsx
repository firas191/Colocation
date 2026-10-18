"use client";
// Delete my account (platform P10, D-109): typed confirmation, then the API erases the person's data and the website
// removes its sign-in. Shared records (expenses, a household's documents made by others) stay without the name.
import { useActionState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { Field, Input, Notice } from "@/components/ui/field";
import { deleteAccountAction, type FormState } from "@/lib/actions/auth";

export function DeleteAccount() {
  const t = useTranslations("account");
  const e = useTranslations("errors");
  const locale = useLocale();
  const [state, action, pending] = useActionState<FormState, FormData>(deleteAccountAction.bind(null, locale), {});
  return (
    <form action={action} className="flex flex-col gap-3 panel p-4">
      <h2 className="text-xl font-semibold">{t("deleteTitle")}</h2>
      <p>{t("deleteLead")}</p>
      <Field id="confirm" label={t("deleteConfirm")}><Input id="confirm" name="confirm" required autoComplete="off" className="ltr-island" /></Field>
      <Button type="submit" variant="secondary" disabled={pending} className="self-start">{t("deleteButton")}</Button>
      {state.error && <Notice tone="error">{state.error === "CONFIRM" ? t("deleteConfirmWrong") : e.has(state.error) ? e(state.error) : e("INTERNAL")}</Notice>}
    </form>
  );
}
