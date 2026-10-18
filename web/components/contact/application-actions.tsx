"use client";
import { useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import { useRouter } from "@/i18n/navigation";
import { Button } from "@/components/ui/button";
import { Notice } from "@/components/ui/field";
import { decideApplicationAction } from "@/lib/actions/contact";
import type { Application } from "@/lib/contact";
import { failure } from "./feedback";

export function ApplicationActions({ a }: { a: Application }) {
  const t = useTranslations("contact");
  const e = useTranslations("errors");
  const router = useRouter();
  const [pending, start] = useTransition();
  const [err, setErr] = useState<string | null>(null);
  const run = (x: "accept" | "decline" | "withdraw") => start(async () => {
    const r = await decideApplicationAction(a.application_id, x, `app-${x}-${crypto.randomUUID()}`);
    if (r.ok) router.refresh(); else setErr(failure(r, t, e));
  });
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap gap-2">
        {a.actions.accept && <Button type="button" onClick={() => run("accept")} disabled={pending}>{t("accept")}</Button>}
        {a.actions.decline && <Button type="button" variant="secondary" onClick={() => run("decline")} disabled={pending}>{t("declineApp")}</Button>}
        {a.actions.withdraw && <Button type="button" variant="secondary" onClick={() => run("withdraw")} disabled={pending}>{t("withdraw")}</Button>}
      </div>
      {err && <Notice tone="error">{err}</Notice>}
    </div>
  );
}
