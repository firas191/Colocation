"use client";
// Ask to get in touch (platform P12, D-115, from Yosr's mutual matching): nothing of the person is shared until the other
// person accepts; then the API opens a direct conversation with the note as its first message.
import { useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { Field, Notice, Textarea } from "@/components/ui/field";
import { contactRequestAction } from "@/lib/actions/flatmates";

export function ContactRequest({ userId }: { userId: string }) {
  const t = useTranslations("flatmates");
  const e = useTranslations("errors");
  const [pending, start] = useTransition();
  const [note, setNote] = useState("");
  const [msg, setMsg] = useState<null | { tone: "ok" | "error"; text: string }>(null);
  const send = () => start(async () => {
    const r = await contactRequestAction(userId, note, `creq-${crypto.randomUUID()}`);
    if (r.ok) { setMsg({ tone: "ok", text: t("contactSent") }); setNote(""); return; }
    setMsg({ tone: "error", text: r.error === "CONFLICT" ? t("alreadyRequested") : r.error && e.has(r.error) ? e(r.error) : e("INTERNAL") });
  });
  if (msg?.tone === "ok") return <Notice tone="ok">{msg.text}</Notice>;
  return (
    <div className="flex flex-col gap-2">
      <p className="text-sm text-ink-soft">{t("contactLead")}</p>
      <Field id="creq-note" label={t("contactNote")}>
        <Textarea id="creq-note" rows={2} maxLength={500} value={note} onChange={(ev) => setNote(ev.target.value)} />
      </Field>
      <Button type="button" variant="primary" onClick={send} disabled={pending} className="self-start">{t("askContact")}</Button>
      {msg && <Notice tone={msg.tone}>{msg.text}</Notice>}
    </div>
  );
}
