"use client";
// Admin forms (platform P11, D-110): one setting of the allowlist, one user's role. The API checks everything.
import { useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import { useRouter } from "@/i18n/navigation";
import { Button } from "@/components/ui/button";
import { Input, Notice, Select } from "@/components/ui/field";
import { adminRoleAction, adminSettingAction } from "@/lib/actions/admin";

export function SettingForm({ k, type, value }: { k: string; type: string; value: unknown }) {
  const t = useTranslations("admin");
  const e = useTranslations("errors");
  const router = useRouter();
  const [v, setV] = useState(type === "bool" ? String(value) : String(value ?? ""));
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<string | null>(null);
  const save = () => start(async () => {
    const val = type === "bool" ? v === "true" : type.startsWith("int") ? Number(v) : v;
    const r = await adminSettingAction(k, val, `set-${crypto.randomUUID()}`);
    setMsg(r.ok ? t("saved") : r.issue === "invalid_for_type" ? t("badValue", { type }) : r.error && e.has(r.error) ? e(r.error) : e("INTERNAL"));
    if (r.ok) router.refresh();
  });
  return (
    <div className="flex flex-wrap items-center gap-2">
      {type === "bool"
        ? <Select aria-label={k} value={v} onChange={(ev) => setV(ev.target.value)}><option value="true">{t("on")}</option><option value="false">{t("off")}</option></Select>
        : <Input aria-label={k} value={v} onChange={(ev) => setV(ev.target.value)} inputMode={type.startsWith("int") ? "numeric" : "text"} className="max-w-60" />}
      <Button type="button" variant="secondary" onClick={save} disabled={pending}>{t("save")}</Button>
      {msg && <span className="text-sm">{msg}</span>}
    </div>
  );
}

export function RoleForm({ userId, role }: { userId: string; role: string }) {
  const t = useTranslations("admin");
  const e = useTranslations("errors");
  const router = useRouter();
  const [v, setV] = useState(role);
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<string | null>(null);
  const save = () => start(async () => {
    const r = await adminRoleAction(userId, v, `role-${crypto.randomUUID()}`);
    setMsg(r.ok ? t("saved") : r.error === "CONFLICT" ? t("ownRole") : r.error && e.has(r.error) ? e(r.error) : e("INTERNAL"));
    if (r.ok) router.refresh();
  });
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Select aria-label={t("role")} value={v} onChange={(ev) => setV(ev.target.value)}>
        {["user", "owner", "moderator", "admin"].map((r) => <option key={r} value={r}>{t(`roles.${r}`)}</option>)}
      </Select>
      <Button type="button" variant="secondary" onClick={save} disabled={pending}>{t("save")}</Button>
      {msg && <Notice>{msg}</Notice>}
    </div>
  );
}
