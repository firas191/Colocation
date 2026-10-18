"use client";
// Archive (rented, withdrawn) or publish again: PATCH /v1/listings/{id} {status}. The API says whether it is allowed.
import { useState, useTransition } from "react";
import { useLocale, useTranslations } from "next-intl";
import { useRouter } from "@/i18n/navigation";
import { Button } from "@/components/ui/button";
import { Notice } from "@/components/ui/field";
import { setStatusAction } from "@/lib/actions/owner";

export function StatusButton({ listingId, to, title }: { listingId: string; to: "archived" | "published"; title: string }) {
  const t = useTranslations("owner");
  const locale = useLocale();
  const router = useRouter();
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<null | { tone: "ok" | "error"; text: string }>(null);
  const run = () => start(async () => {
    const r = await setStatusAction(locale, listingId, to, `status-${to}-${crypto.randomUUID()}`);
    setMsg(r.ok ? { tone: "ok", text: to === "archived" ? t("archivedDone") : t("republishedDone") } : { tone: "error", text: t("actionFailed") });
    if (r.ok) router.refresh();
  });
  return (
    <div className="flex flex-col gap-2">
      <Button type="button" variant="secondary" onClick={run} disabled={pending}
        aria-label={`${to === "archived" ? t("archive") : t("republish")}: ${title}`}>
        {to === "archived" ? t("archive") : t("republish")}
      </Button>
      {msg && <Notice tone={msg.tone}>{msg.text}</Notice>}
    </div>
  );
}
