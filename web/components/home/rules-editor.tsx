"use client";
// House rules (platform P6): the whole list, PUT /v1/households/{id}/rules.
import { useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import { useRouter } from "@/i18n/navigation";
import { Button } from "@/components/ui/button";
import { Input, Notice, Select } from "@/components/ui/field";
import { homeAction } from "@/lib/actions/home";

const CATS = ["quiet", "guests", "cleaning", "kitchen", "smoking", "pets", "other"];

export function RulesEditor({ householdId, items }: { householdId: string; items: Array<{ category: string; text: string }> }) {
  const t = useTranslations("home");
  const router = useRouter();
  const [rows, setRows] = useState(items);
  const [msg, setMsg] = useState<null | { tone: "ok" | "error"; text: string }>(null);
  const [pending, start] = useTransition();
  const save = () => start(async () => {
    const r = await homeAction("PUT", `/v1/households/${householdId}/rules`, { items: rows.filter((x) => x.text.trim()) }, `rules-${crypto.randomUUID()}`);
    setMsg(r.ok ? { tone: "ok", text: t("saved") } : { tone: "error", text: t("failed") });
    if (r.ok) router.refresh();
  });
  return (
    <div className="flex flex-col gap-3">
      <ol className="flex flex-col gap-3">
        {rows.map((r, i) => (
          <li key={i} className="grid grid-cols-1 gap-2 sm:grid-cols-[10rem_1fr_auto] sm:items-end">
            <label className="flex flex-col gap-1 text-sm">{t("category")}
              <Select value={r.category} onChange={(ev) => setRows((x) => x.map((y, j) => (j === i ? { ...y, category: ev.target.value } : y)))}>
                {CATS.map((c) => <option key={c} value={c}>{t(`ruleCats.${c}`)}</option>)}
              </Select></label>
            <label className="flex flex-col gap-1 text-sm">{t("rule")}
              <Input value={r.text} maxLength={300} onChange={(ev) => setRows((x) => x.map((y, j) => (j === i ? { ...y, text: ev.target.value } : y)))} /></label>
            <Button type="button" variant="quiet" onClick={() => setRows((x) => x.filter((_, j) => j !== i))}>{t("remove")}</Button>
          </li>
        ))}
      </ol>
      <div className="flex flex-wrap gap-3">
        <Button type="button" variant="secondary" onClick={() => setRows((x) => [...x, { category: "other", text: "" }])}>{t("addRule")}</Button>
        <Button type="button" onClick={save} disabled={pending}>{t("save")}</Button>
      </div>
      {msg && <Notice tone={msg.tone}>{msg.text}</Notice>}
    </div>
  );
}
