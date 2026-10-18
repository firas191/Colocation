"use client";
// "Why this score?" (D-115, from Yosr's match explanation): one sentence from the factor states. The model writes it when
// it is on and its sentence passes the code check; otherwise the code writes it. Says which of the two wrote it.
import { useState, useTransition } from "react";
import { useLocale, useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { Notice } from "@/components/ui/field";
import { explainAction, type Explanation } from "@/lib/actions/flatmates";

export function ExplainMatch({ userId }: { userId: string }) {
  const t = useTranslations("flatmates");
  const e = useTranslations("errors");
  const locale = useLocale();
  const [pending, start] = useTransition();
  const [x, setX] = useState<Explanation | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const ask = () => start(async () => {
    setErr(null);
    const r = await explainAction(userId, locale, `expl-${crypto.randomUUID()}`);
    if (r.ok && r.data) setX(r.data); else setErr(r.error && e.has(r.error) ? e(r.error) : e("INTERNAL"));
  });
  if (x) return (
    <div className="flex flex-col gap-1" aria-live="polite">
      <p>{x.sentence}</p>
      <p className="text-xs text-ink-soft">{x.source === "model" ? t("byModel") : t("byCode")}</p>
    </div>
  );
  return (
    <div className="flex flex-col gap-2">
      <Button type="button" onClick={ask} disabled={pending} className="self-start">{pending ? t("explaining") : t("explain")}</Button>
      {err && <Notice tone="error">{err}</Notice>}
    </div>
  );
}
