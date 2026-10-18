"use client";
// The buttons of one visit: the API says which apply now (actions); proposing another time asks for it.
import { useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import { useRouter } from "@/i18n/navigation";
import { Button } from "@/components/ui/button";
import { Field, Input, Notice } from "@/components/ui/field";
import { decideVisitAction } from "@/lib/actions/contact";
import type { Visit } from "@/lib/contact";
import { failure } from "./feedback";

const ORDER = ["confirm", "decline", "propose", "cancel", "done", "no_show"] as const;

export function VisitActions({ v }: { v: Visit }) {
  const t = useTranslations("contact");
  const e = useTranslations("errors");
  const router = useRouter();
  const [pending, start] = useTransition();
  const [proposing, setProposing] = useState(false);
  const [when, setWhen] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const run = (a: string, at: string | null = null) => start(async () => {
    const r = await decideVisitAction(v.visit_id, a, at, `visit-${a}-${crypto.randomUUID()}`);
    if (r.ok) { setProposing(false); setErr(null); router.refresh(); } else setErr(failure(r, t, e));
  });
  const shown = ORDER.filter((a) => v.actions[a]);
  if (!shown.length) return null;
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap gap-2">
        {shown.map((a) => (
          <Button key={a} type="button" variant={a === "confirm" ? "primary" : "secondary"} disabled={pending}
            onClick={() => (a === "propose" ? setProposing(!proposing) : run(a))}>{t(`actions.${a}`)}</Button>
        ))}
      </div>
      {proposing && (
        <div className="flex flex-wrap items-end gap-2">
          <Field id={`when-${v.visit_id}`} label={t("newTime")}>
            <Input id={`when-${v.visit_id}`} type="datetime-local" value={when} onChange={(ev) => setWhen(ev.target.value)} />
          </Field>
          <Button type="button" disabled={pending || !when} onClick={() => run("propose", new Date(when).toISOString())}>{t("proposeSend")}</Button>
        </div>
      )}
      {err && <Notice tone="error">{err}</Notice>}
    </div>
  );
}
