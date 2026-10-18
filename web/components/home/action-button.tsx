"use client";
// A button that makes one household API call and reloads the page's data (platform P5, P6).
import { useState, useTransition, type ReactNode } from "react";
import { useTranslations } from "next-intl";
import { useRouter } from "@/i18n/navigation";
import { Button } from "@/components/ui/button";
import { Notice } from "@/components/ui/field";
import { homeAction } from "@/lib/actions/home";

export function ActionButton({ method = "POST", path, body, children, variant = "secondary", done, then }:
  { method?: "POST" | "PUT" | "PATCH" | "DELETE"; path: string; body?: unknown; children: ReactNode; variant?: "primary" | "secondary" | "quiet";
    done?: string; then?: string }) {
  const t = useTranslations("home");
  const e = useTranslations("errors");
  const router = useRouter();
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<null | { tone: "ok" | "error"; text: string }>(null);
  const run = () => start(async () => {
    const r = await homeAction(method, path, body, `home-${crypto.randomUUID()}`);
    if (r.ok) { setMsg(done ? { tone: "ok", text: done } : null); if (then) router.push(then); else router.refresh(); }
    else setMsg({ tone: "error", text: r.issue && t.has(`issues.${r.issue}`) ? t(`issues.${r.issue}`) : (r.error && e.has(r.error) ? e(r.error) : t("failed")) });
  });
  return (
    <span className="inline-flex flex-col gap-2">
      <Button type="button" variant={variant} onClick={run} disabled={pending}>{children}</Button>
      {msg && <Notice tone={msg.tone}>{msg.text}</Notice>}
    </span>
  );
}
