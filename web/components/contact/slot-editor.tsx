"use client";
// The owner's visit times on the listing's page (platform P4): PUT /v1/listings/{id}/visit-slots with the whole list.
import { useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import { useRouter } from "@/i18n/navigation";
import { Button } from "@/components/ui/button";
import { Input, Notice } from "@/components/ui/field";
import { saveSlotsAction } from "@/lib/actions/contact";
import { failure } from "./feedback";

type Row = { start: string; end: string; capacity: string };
// datetime-local works in the browser's time zone; the API gets ISO times with the offset
const local = (iso: string) => { const d = new Date(iso); return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16); };

export function SlotEditor({ listingId, slots }: { listingId: string; slots: Array<{ starts_at: string; ends_at: string; capacity: number }> }) {
  const t = useTranslations("contact");
  const e = useTranslations("errors");
  const router = useRouter();
  const [rows, setRows] = useState<Row[]>(slots.map((s) => ({ start: local(s.starts_at), end: local(s.ends_at), capacity: String(s.capacity) })));
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<null | { tone: "ok" | "error"; text: string }>(null);
  const set = (i: number, k: keyof Row, v: string) => setRows((r) => r.map((x, j) => (j === i ? { ...x, [k]: v } : x)));
  const save = () => start(async () => {
    const body = rows.filter((r) => r.start && r.end).map((r) => ({ starts_at: new Date(r.start).toISOString(), ends_at: new Date(r.end).toISOString(),
      capacity: Math.max(1, Math.min(20, Number(r.capacity) || 1)) }));
    const res = await saveSlotsAction(listingId, body, `slots-${crypto.randomUUID()}`);
    setMsg(res.ok ? { tone: "ok", text: t("slotsSaved") } : { tone: "error", text: failure(res, t, e) });
    if (res.ok) router.refresh();
  });
  return (
    <div className="flex flex-col gap-3">
      {rows.length === 0 && <p className="text-ink-soft">{t("noOwnSlots")}</p>}
      <ul className="flex flex-col gap-3">
        {rows.map((r, i) => (
          <li key={i} className="grid grid-cols-1 gap-2 sm:grid-cols-[1fr_1fr_6rem_auto] sm:items-end">
            <label className="flex flex-col gap-1 text-sm">{t("slotStart")}<Input type="datetime-local" value={r.start} onChange={(ev) => set(i, "start", ev.target.value)} /></label>
            <label className="flex flex-col gap-1 text-sm">{t("slotEnd")}<Input type="datetime-local" value={r.end} onChange={(ev) => set(i, "end", ev.target.value)} /></label>
            <label className="flex flex-col gap-1 text-sm">{t("slotCapacity")}<Input type="number" min={1} max={20} value={r.capacity} onChange={(ev) => set(i, "capacity", ev.target.value)} /></label>
            <Button type="button" variant="quiet" onClick={() => setRows((x) => x.filter((_, j) => j !== i))}>{t("removeSlot")}</Button>
          </li>
        ))}
      </ul>
      <div className="flex flex-wrap gap-3">
        <Button type="button" variant="secondary" onClick={() => setRows((x) => [...x, { start: "", end: "", capacity: "1" }])}>{t("addSlot")}</Button>
        <Button type="button" onClick={save} disabled={pending}>{t("saveSlots")}</Button>
      </div>
      {msg && <Notice tone={msg.tone}>{msg.text}</Notice>}
    </div>
  );
}
