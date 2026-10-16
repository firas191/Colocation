"use client";
import { useActionState } from "react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { Check, Notice } from "@/components/ui/field";
import { Link } from "@/i18n/navigation";
import { consentAction, type ActionState } from "@/lib/actions/platform";

export function ConsentForm({ locale, idem, media }: { locale: string; idem: string; media: boolean }) {
  const t = useTranslations("consent");
  const e = useTranslations("errors");
  const c = useTranslations("common");
  const [state, action, pending] = useActionState<ActionState, FormData>(consentAction.bind(null, locale), {});
  return (
    <form action={action} className="flex flex-col gap-5">
      {state.error === "consent_required" && <Notice tone="error">{t("required")}</Notice>}
      {state.error && state.error !== "consent_required" && <Notice tone="error">{e.has(state.error) ? e(state.error) : e("INTERNAL")}</Notice>}
      <input type="hidden" name="idem" value={idem} />
      <Check id="terms" name="terms" required label={<>{t("terms")}. <Link href="/terms" target="_blank">{t("termsLink")}</Link></>} />
      <Check id="privacy" name="privacy" required label={<>{t("privacy")}. <Link href="/privacy" target="_blank">{t("privacyLink")}</Link></>} />
      <Check id="adult" name="adult" required label={t("adult")} />
      <Check id="media" name="media" defaultChecked={media} label={<>{t("media")} <span className="text-ink-soft">({c("optional")})</span></>} />
      <Button type="submit" disabled={pending} className="self-start">{t("submit")}</Button>
    </form>
  );
}
