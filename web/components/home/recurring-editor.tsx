"use client";
// Rent and bills that come back every month (platform P5): PUT /v1/households/{id}/recurring with the whole list.
// The daily workflow reminds the flatmates before each due date.
import { useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import { useRouter } from "@/i18n/navigation";
import { Button } from "@/components/ui/button";
import { Input, Notice, Select } from "@/components/ui/field";
import { homeAction } from "@/lib/actions/home";

type Row = { kind: string; label: string; amount: string; due_day: string; remind: string };

export function RecurringEditor({ householdId, items, exponent }:
  { householdId: string; exponent: number; items: Array<{ kind: string; label: string; amount_minor: number | null; due_day: number; remind_days_before: number }> }) {
  const t = useTranslations("home");
  const e = useTranslations("errors");
  const router = useRouter();
  const [rows, setRows] = useState<Row[]>(items.map((i) => ({ kind: i.kind, label: i.label, amount: i.amount_minor ? String(i.amount_minor / 10 ** exponent) : "",
    due_day: String(i.due_day), remind: String(i.remind_days_before) })));
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<null | { tone: "ok" | "error"; text: string }>(null);
  const set = (i: number, k: keyof Row, v: string) => setRows((r) => r.map((x, j) => (j === i ? { ...x, [k]: v } : x)));
  const save = () => start(async () => {
    const body = { items: rows.filter((r) => r.label.trim()).map((r) => {
      const o: Record<string, unknown> = { kind: r.kind, label: r.label.trim(), due_day: Number(r.due_day), remind_days_before: Number(r.remind || "3") };
      const a = r.amount.trim().replace(",", ".");
      if (a) o.amount_minor = Math.round(Number(a) * 10 ** exponent);
      return o; }) };
    const res = await homeAction("PUT", `/v1/households/${householdId}/recurring`, body, `rec-${crypto.randomUUID()}`);
    setMsg(res.ok ? { tone: "ok", text: t("saved") } : { tone: "error", text: res.error && e.has(res.error) ? e(res.error) : t("failed") });
    if (res.ok) router.refresh();
  });
  return (
    <div className="flex flex-col gap-3">
      <ul className="flex flex-col gap-3">
        {rows.map((r, i) => (
          <li key={i} className="grid grid-cols-2 gap-2 sm:grid-cols-[7rem_1fr_7rem_5rem_5rem_auto] sm:items-end">
            <label className="flex flex-col gap-1 text-sm">{t("kind")}
              <Select value={r.kind} onChange={(ev) => set(i, "kind", ev.target.value)}><option value="rent">{t("kinds.rent")}</option><option value="bill">{t("kinds.bill")}</option></Select></label>
            <label className="flex flex-col gap-1 text-sm">{t("label")}<Input value={r.label} maxLength={80} onChange={(ev) => set(i, "label", ev.target.value)} /></label>
            <label className="flex flex-col gap-1 text-sm">{t("amount")}<Input inputMode="decimal" value={r.amount} onChange={(ev) => set(i, "amount", ev.target.value)} /></label>
            <label className="flex flex-col gap-1 text-sm">{t("dueDay")}<Input type="number" min={1} max={28} value={r.due_day} onChange={(ev) => set(i, "due_day", ev.target.value)} /></label>
            <label className="flex flex-col gap-1 text-sm">{t("remindBefore")}<Input type="number" min={0} max={14} value={r.remind} onChange={(ev) => set(i, "remind", ev.target.value)} /></label>
            <Button type="button" variant="quiet" onClick={() => setRows((x) => x.filter((_, j) => j !== i))}>{t("remove")}</Button>
          </li>
        ))}
      </ul>
      <div className="flex flex-wrap gap-3">
        <Button type="button" variant="secondary" onClick={() => setRows((x) => [...x, { kind: "bill", label: "", amount: "", due_day: "1", remind: "3" }])}>{t("addItem")}</Button>
        <Button type="button" onClick={save} disabled={pending}>{t("save")}</Button>
      </div>
      {msg && <Notice tone={msg.tone}>{msg.text}</Notice>}
    </div>
  );
}
