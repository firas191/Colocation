"use client";
// Accept, refuse or cancel one contact request (D-115). The buttons shown are the ones the API says are allowed.
import { useTransition, useState } from "react";
import { useTranslations } from "next-intl";
import { useRouter } from "@/i18n/navigation";
import { Button } from "@/components/ui/button";
import { Notice } from "@/components/ui/field";
import { decideContactRequestAction } from "@/lib/actions/flatmates";

export function RequestActions({ id, actions }: { id: string; actions: { accept: boolean; refuse: boolean; cancel: boolean } }) {
  const t = useTranslations("flatmates");
  const e = useTranslations("errors");
  const router = useRouter();
  const [pending, start] = useTransition();
  const [err, setErr] = useState<string | null>(null);
  const go = (action: "accept" | "refuse" | "cancel") => start(async () => {
    setErr(null);
    const r = await decideContactRequestAction(id, action, `cdec-${crypto.randomUUID()}`);
    if (!r.ok) { setErr(r.error && e.has(r.error) ? e(r.error) : e("INTERNAL")); return; }
    if (action === "accept" && r.data?.conversation_id) router.push(`/messages/${r.data.conversation_id}`);
    else router.refresh();
  });
  return (
    <div className="flex flex-wrap items-center gap-2">
      {actions.accept && <Button type="button" variant="primary" disabled={pending} onClick={() => go("accept")}>{t("accept")}</Button>}
      {actions.refuse && <Button type="button" disabled={pending} onClick={() => go("refuse")}>{t("refuse")}</Button>}
      {actions.cancel && <Button type="button" disabled={pending} onClick={() => go("cancel")}>{t("cancel")}</Button>}
      {err && <Notice tone="error">{err}</Notice>}
    </div>
  );
}
