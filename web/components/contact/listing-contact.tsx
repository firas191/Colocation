"use client";
// On a published listing (platform P4): write to the owner, ask for a visit in one of the owner's slots, apply, report.
// Each button is one API call; what is allowed (blocked, full, already applied) comes back from the API.
import { useState, useTransition } from "react";
import { useFormatter, useTranslations } from "next-intl";
import { useRouter } from "@/i18n/navigation";
import { Button } from "@/components/ui/button";
import { Check, Field, Input, Notice, Select, Textarea } from "@/components/ui/field";
import { applyAction, reportAction, requestVisitAction, startConversationAction, type Result } from "@/lib/actions/contact";
import { failure } from "./feedback";

export interface Slot { slot_id: string; starts_at: string; ends_at: string; capacity: number; free: number }
type Msg = { tone: "ok" | "error"; text: string } | null;
const key = (p: string) => `${p}-${crypto.randomUUID()}`;

export function ListingContact({ listingId, slots }: { listingId: string; slots: Slot[] }) {
  const t = useTranslations("contact");
  const e = useTranslations("errors");
  const fmt = useFormatter();
  const router = useRouter();
  const [pending, start] = useTransition();
  const [text, setText] = useState("");
  const [note, setNote] = useState("");
  const [msg, setMsg] = useState<Record<string, Msg>>({});
  const say = (k: string, r: Pick<Result, "ok" | "error" | "issue">, ok: string) => setMsg((m) => ({ ...m, [k]: r.ok ? { tone: "ok", text: ok } : { tone: "error", text: failure(r, t, e) } }));

  const write = () => start(async () => {
    const r = await startConversationAction(listingId, text, key("conv"));
    if (r.ok && r.data) { router.push(`/messages/${r.data.conversation.conversation_id}`); return; }
    say("write", r, "");
  });
  const visit = (slot: string) => start(async () => { const r = await requestVisitAction(slot, note, key("visit")); say("visit", r, t("visitAsked")); if (r.ok) router.refresh(); });
  const apply = (f: FormData) => start(async () => {
    const r = await applyAction(listingId, String(f.get("message") || ""), String(f.get("move_in_from") || ""), !!f.get("share"), key("apply"));
    say("apply", r, t("applied"));
  });
  const report = (f: FormData) => start(async () => {
    const r = await reportAction("listing", listingId, String(f.get("reason") || "other"), String(f.get("detail") || ""), key("report"));
    say("report", r, t("reported"));
  });
  const when = (s: Slot) => `${fmt.dateTime(new Date(s.starts_at), { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}`
    + ` – ${fmt.dateTime(new Date(s.ends_at), { hour: "2-digit", minute: "2-digit" })}`;
  const box = "flex flex-col gap-3 panel p-4";
  return (
    <div className="flex flex-col gap-4">
      <section aria-labelledby="write-title" className={box}>
        <h2 id="write-title" className="section-title">{t("write")}</h2>
        <p className="text-sm text-ink-soft">{t("writeHint")}</p>
        <label htmlFor="first-message" className="sr-only">{t("messagePlaceholder")}</label>
        <Textarea id="first-message" value={text} onChange={(ev) => setText(ev.target.value)} placeholder={t("messagePlaceholder")} maxLength={4000} rows={3} />
        <Button type="button" onClick={write} disabled={pending || !text.trim()} className="self-start">{t("send")}</Button>
        {msg.write && <Notice tone={msg.write.tone}>{msg.write.text}</Notice>}
      </section>

      <section aria-labelledby="visit-title" className={box}>
        <h2 id="visit-title" className="section-title">{t("visitsTitle")}</h2>
        {slots.length === 0 ? <p className="text-sm text-ink-soft">{t("noSlots")}</p> : (
          <>
            <ul className="flex flex-col gap-2">
              {slots.map((s) => (
                <li key={s.slot_id} className="flex flex-wrap items-center justify-between gap-2">
                  <span><span className="ltr-island">{when(s)}</span> · <span className="text-ink-soft">{t("free", { count: s.free })}</span></span>
                  <Button type="button" variant="secondary" onClick={() => visit(s.slot_id)} disabled={pending || s.free < 1}
                    aria-label={`${t("askVisit")}: ${when(s)}`}>{t("askVisit")}</Button>
                </li>
              ))}
            </ul>
            <Field id="visit-note" label={t("note")}><Input id="visit-note" value={note} onChange={(ev) => setNote(ev.target.value)} maxLength={500} /></Field>
          </>
        )}
        {msg.visit && <Notice tone={msg.visit.tone}>{msg.visit.text}</Notice>}
      </section>

      <section aria-labelledby="apply-title" className={box}>
        <h2 id="apply-title" className="section-title">{t("applyTitle")}</h2>
        <p className="text-sm text-ink-soft">{t("applyHint")}</p>
        <form action={apply} className="flex flex-col gap-3">
          <Field id="apply-message" label={t("applyMessage")}><Textarea id="apply-message" name="message" maxLength={2000} rows={3} /></Field>
          <Field id="apply-date" label={t("moveIn")}><Input id="apply-date" name="move_in_from" type="date" /></Field>
          <Check id="apply-share" name="share" label={t("share")} defaultChecked />
          <Button type="submit" disabled={pending} className="self-start">{t("applyButton")}</Button>
        </form>
        {msg.apply && <Notice tone={msg.apply.tone}>{msg.apply.text}</Notice>}
      </section>

      <details className="panel p-4">
        <summary className="cursor-pointer font-semibold">{t("reportTitle")}</summary>
        <form action={report} className="mt-3 flex flex-col gap-3">
          <Field id="report-reason" label={t("reason")}>
            <Select id="report-reason" name="reason" defaultValue="scam">
              {["scam", "wrong_info", "offensive", "discrimination", "spam", "other"].map((x) => <option key={x} value={x}>{t(`reasons.${x}`)}</option>)}
            </Select>
          </Field>
          <Field id="report-detail" label={t("detail")}><Textarea id="report-detail" name="detail" maxLength={1000} rows={2} /></Field>
          <Button type="submit" variant="secondary" disabled={pending} className="self-start">{t("reportButton")}</Button>
        </form>
        {msg.report && <div className="mt-3"><Notice tone={msg.report.tone}>{msg.report.text}</Notice></div>}
      </details>
    </div>
  );
}
