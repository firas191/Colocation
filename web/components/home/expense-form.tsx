"use client";
// Add an expense (platform P5): amount in the household's currency, who paid, who shares it and how. "Preview" asks
// the API for the split without saving; "Save" adds it. The split itself is computed by the API (api.split).
import { useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import { useRouter } from "@/i18n/navigation";
import { Button } from "@/components/ui/button";
import { Field, Input, Notice, Select } from "@/components/ui/field";
import { homeAction } from "@/lib/actions/home";

interface Mate { user_id: string; display_name: string | null }
const CATS = ["groceries", "rent", "utilities", "internet", "household", "other"] as const;

export function ExpenseForm({ householdId, mates, me, exponent, currency }:
  { householdId: string; mates: Mate[]; me: string; exponent: number; currency: string }) {
  const t = useTranslations("home");
  const e = useTranslations("errors");
  const router = useRouter();
  const [amount, setAmount] = useState(""); const [label, setLabel] = useState(""); const [cat, setCat] = useState<string>("groceries");
  const [paidBy, setPaidBy] = useState(me); const [mode, setMode] = useState("equal");
  const [who, setWho] = useState<string[]>(mates.map((m) => m.user_id));
  const [vals, setVals] = useState<Record<string, string>>({});
  const [preview, setPreview] = useState<Array<{ user_id: string; display_name: string | null; share_minor: number }> | null>(null);
  const [msg, setMsg] = useState<null | { tone: "ok" | "error"; text: string }>(null);
  const [pending, start] = useTransition();
  const minor = (v: string) => { const x = v.trim().replace(",", "."); return /^\d{1,9}(\.\d{1,3})?$/.test(x) ? Math.round(Number(x) * 10 ** exponent) : NaN; };
  const fmt = (m: number) => new Intl.NumberFormat(undefined, { style: "currency", currency, maximumFractionDigits: exponent }).format(m / 10 ** exponent);
  const body = (pv: boolean) => {
    const b: Record<string, unknown> = { amount_minor: minor(amount), label: label.trim(), category: cat, paid_by: paidBy, split_mode: mode,
      participants: who, preview: pv };
    if (mode === "shares") b.values = who.map((u) => Number(vals[u] || "1"));
    if (mode === "exact") b.values = who.map((u) => minor(vals[u] || "0"));
    return b;
  };
  const send = (pv: boolean) => start(async () => {
    const b = body(pv);
    if (Number.isNaN(b.amount_minor as number) || !label.trim()) { setMsg({ tone: "error", text: t("amountLabelNeeded") }); return; }
    const r = await homeAction("POST", `/v1/households/${householdId}/expenses`, b, `exp-${crypto.randomUUID()}`);
    if (!r.ok) { setMsg({ tone: "error", text: r.issue && t.has(`issues.${r.issue}`) ? t(`issues.${r.issue}`) : (r.error && e.has(r.error) ? e(r.error) : t("failed")) }); return; }
    if (pv) { setPreview(r.data.shares); setMsg(null); return; }
    setPreview(null); setAmount(""); setLabel(""); setVals({}); setMsg({ tone: "ok", text: t("expenseSaved") }); router.refresh();
  });
  return (
    <div className="flex flex-col gap-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <Field id="exp-amount" label={`${t("amount")} (${currency})`}><Input id="exp-amount" inputMode="decimal" value={amount} onChange={(ev) => setAmount(ev.target.value)} /></Field>
        <Field id="exp-label" label={t("label")}><Input id="exp-label" value={label} maxLength={120} onChange={(ev) => setLabel(ev.target.value)} /></Field>
        <Field id="exp-cat" label={t("category")}>
          <Select id="exp-cat" value={cat} onChange={(ev) => setCat(ev.target.value)}>{CATS.map((c) => <option key={c} value={c}>{t(`categories.${c}`)}</option>)}</Select>
        </Field>
        <Field id="exp-paid" label={t("paidBy")}>
          <Select id="exp-paid" value={paidBy} onChange={(ev) => setPaidBy(ev.target.value)}>{mates.map((m) => <option key={m.user_id} value={m.user_id}>{m.display_name || "?"}</option>)}</Select>
        </Field>
        <Field id="exp-mode" label={t("splitMode")}>
          <Select id="exp-mode" value={mode} onChange={(ev) => { setMode(ev.target.value); setPreview(null); }}>
            {["equal", "shares", "exact"].map((m) => <option key={m} value={m}>{t(`modes.${m}`)}</option>)}
          </Select>
        </Field>
      </div>
      <fieldset className="flex flex-col gap-2">
        <legend className="mb-1 text-sm font-semibold">{t("sharedBy")}</legend>
        {mates.map((m) => (
          <div key={m.user_id} className="flex flex-wrap items-center gap-3">
            <label className="flex min-h-10 items-center gap-2">
              <input type="checkbox" className="size-5 accent-door" checked={who.includes(m.user_id)}
                onChange={(ev) => setWho((w) => ev.target.checked ? mates.map((x) => x.user_id).filter((u) => u === m.user_id || w.includes(u)) : w.filter((u) => u !== m.user_id))} />
              {m.display_name || "?"}
            </label>
            {mode !== "equal" && who.includes(m.user_id) && (
              <Input aria-label={`${mode === "shares" ? t("weight") : t("amount")}: ${m.display_name || ""}`} className="w-28" inputMode="decimal"
                value={vals[m.user_id] || ""} placeholder={mode === "shares" ? "1" : "0"} onChange={(ev) => setVals({ ...vals, [m.user_id]: ev.target.value })} />
            )}
          </div>
        ))}
      </fieldset>
      <div className="flex flex-wrap gap-3">
        <Button type="button" variant="secondary" onClick={() => send(true)} disabled={pending}>{t("preview")}</Button>
        <Button type="button" onClick={() => send(false)} disabled={pending}>{t("saveExpense")}</Button>
      </div>
      {preview && (
        <ul className="panel p-3 text-[0.95rem]" aria-label={t("preview")}>
          {preview.map((p) => <li key={p.user_id}>{p.display_name || "?"} · <span className="ltr-island">{fmt(p.share_minor)}</span></li>)}
        </ul>
      )}
      {msg && <Notice tone={msg.tone}>{msg.text}</Notice>}
    </div>
  );
}
