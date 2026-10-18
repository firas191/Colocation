"use client";
// A new invite code (shown once; the API keeps only its hash) and the link to share it.
import { useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { Notice, Select } from "@/components/ui/field";
import { homeAction } from "@/lib/actions/home";

export function InviteButton({ householdId, locale }: { householdId: string; locale: string }) {
  const t = useTranslations("home");
  const [role, setRole] = useState("flatmate");
  const [code, setCode] = useState<{ code: string; expires_at: string } | null>(null);
  const [err, setErr] = useState(false);
  const [pending, start] = useTransition();
  const make = () => start(async () => {
    const r = await homeAction("POST", `/v1/households/${householdId}/invites`, { role }, `inv-${crypto.randomUUID()}`);
    if (r.ok) { setCode(r.data); setErr(false); } else setErr(true);
  });
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1 text-sm font-semibold">{t("inviteAs")}
          <Select value={role} onChange={(ev) => setRole(ev.target.value)}><option value="flatmate">{t("roles.flatmate")}</option><option value="owner">{t("roles.owner")}</option></Select>
        </label>
        <Button type="button" variant="secondary" onClick={make} disabled={pending}>{t("newCode")}</Button>
      </div>
      {code && (
        <Notice tone="ok">
          {t("codeShown")} <span className="font-bold ltr-island">{code.code}</span>
          <br /><span className="ltr-island break-all">{`${typeof window !== "undefined" ? window.location.origin : ""}/${locale}/join/${code.code}`}</span>
        </Notice>
      )}
      {err && <Notice tone="error">{t("failed")}</Notice>}
    </div>
  );
}
