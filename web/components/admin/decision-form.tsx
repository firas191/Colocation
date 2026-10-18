"use client";
// One moderation decision (approve, reject, dismiss, hide the message, warn), with a note and a reason code.
import { useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import { useRouter } from "@/i18n/navigation";
import { Button } from "@/components/ui/button";
import { Field, Notice, Select, Textarea } from "@/components/ui/field";
import { moderationDecideAction } from "@/lib/actions/admin";

export function DecisionForm({ itemId, actions }: { itemId: number; actions: string[] }) {
  const t = useTranslations("admin");
  const e = useTranslations("errors");
  const router = useRouter();
  const [pending, start] = useTransition();
  const [note, setNote] = useState("");
  const [code, setCode] = useState("");
  const [msg, setMsg] = useState<null | { tone: "ok" | "error"; text: string }>(null);
  const decide = (a: string) => start(async () => {
    const r = await moderationDecideAction(itemId, a, note, code, `mod-${crypto.randomUUID()}`);
    setMsg(r.ok ? { tone: "ok", text: t(`effects.${r.effect || "none"}`) } : { tone: "error", text: r.error && e.has(r.error) ? e(r.error) : e("INTERNAL") });
    if (r.ok) router.refresh();
  });
  return (
    <div className="flex flex-col gap-3">
      <Field id={`note-${itemId}`} label={t("note")}>
        <Textarea id={`note-${itemId}`} rows={2} maxLength={1000} value={note} onChange={(ev) => setNote(ev.target.value)} />
      </Field>
      <Field id={`code-${itemId}`} label={t("code")}>
        <Select id={`code-${itemId}`} value={code} onChange={(ev) => setCode(ev.target.value)}>
          <option value="">—</option>
          {["scam", "stolen_photos", "wrong_info", "offensive", "discrimination", "spam", "other"].map((c) => <option key={c} value={c}>{t(`codes.${c}`)}</option>)}
        </Select>
      </Field>
      <div className="flex flex-wrap gap-2">
        {actions.map((a) => (
          <Button key={a} type="button" variant={a === "approve" ? "primary" : "secondary"} disabled={pending} onClick={() => decide(a)}>{t(`actions.${a}`)}</Button>
        ))}
      </div>
      {msg && <Notice tone={msg.tone}>{msg.text}</Notice>}
    </div>
  );
}
