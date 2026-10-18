"use client";
// Writing in a conversation, blocking the other person, reporting their last message (platform P4).
import { useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import { useRouter } from "@/i18n/navigation";
import { Button } from "@/components/ui/button";
import { Notice, Textarea } from "@/components/ui/field";
import { blockAction, reportAction, sendMessageAction } from "@/lib/actions/contact";
import { failure } from "./feedback";

export function Thread({ conversationId, otherId, blocked, lastOtherMessage }:
  { conversationId: string; otherId: string | null; blockedByMe: boolean; blocked: boolean; lastOtherMessage: number | null }) {
  const t = useTranslations("contact");
  const e = useTranslations("errors");
  const router = useRouter();
  const [text, setText] = useState("");
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<null | { tone: "ok" | "error"; text: string }>(null);
  const send = () => start(async () => {
    const r = await sendMessageAction(conversationId, text, `msg-${crypto.randomUUID()}`);
    if (r.ok) { setText(""); setMsg(null); router.refresh(); } else setMsg({ tone: "error", text: failure(r, t, e) });
  });
  const block = (on: boolean) => start(async () => {
    if (!otherId) return;
    const r = await blockAction(otherId, on, `block-${crypto.randomUUID()}`);
    setMsg(r.ok ? { tone: "ok", text: on ? t("blockedDone") : t("unblockedDone") } : { tone: "error", text: failure(r, t, e) });
    router.refresh();
  });
  const report = () => start(async () => {
    if (!lastOtherMessage) return;
    const r = await reportAction("message", String(lastOtherMessage), "offensive", "", `report-${crypto.randomUUID()}`);
    setMsg(r.ok ? { tone: "ok", text: t("reported") } : { tone: "error", text: failure(r, t, e) });
  });
  return (
    <div className="flex flex-col gap-3">
      <form onSubmit={(ev) => { ev.preventDefault(); if (text.trim()) send(); }}
        className="panel sticky bottom-3 flex flex-col gap-3 p-3 shadow-[var(--shadow-lift)] focus-within:border-door">
        <label htmlFor="reply" className="px-1 text-sm font-semibold">{t("messagePlaceholder")}</label>
        <Textarea id="reply" value={text} onChange={(ev) => setText(ev.target.value)} maxLength={4000} rows={3} className="border-0 bg-transparent focus:shadow-none" />
        <div className="flex flex-wrap items-center gap-3">
          <Button type="submit" disabled={pending || !text.trim()}>{pending ? t("sending") : t("send")}</Button>
          {otherId && <Button type="button" variant="secondary" onClick={() => block(!blocked)} disabled={pending}>{blocked ? t("unblock") : t("block")}</Button>}
          {lastOtherMessage && <Button type="button" variant="quiet" onClick={report} disabled={pending}>{t("reportMessage")}</Button>}
        </div>
      </form>
      {msg && <Notice tone={msg.tone}>{msg.text}</Notice>}
    </div>
  );
}
