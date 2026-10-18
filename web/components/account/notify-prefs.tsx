"use client";
// Notification channels (platform P11, D-110): e-mail and Telegram on or off, types kept in the app only, and the
// one-time code to link a Telegram chat (sent to the bot as "/lier CODE").
import { useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import { useRouter } from "@/i18n/navigation";
import { Button } from "@/components/ui/button";
import { Notice } from "@/components/ui/field";
import { savePrefsAction, telegramLinkAction } from "@/lib/actions/notify";

export function NotifyPrefs({ initial, types, linked }: { initial: { email: boolean; telegram: boolean; muted: string[] }; types: string[]; linked: boolean }) {
  const t = useTranslations("account");
  const e = useTranslations("errors");
  const router = useRouter();
  const [p, setP] = useState(initial);
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<null | { tone: "ok" | "error"; text: string }>(null);
  const [code, setCode] = useState<string | null>(null);
  const save = () => start(async () => {
    const r = await savePrefsAction(p, `prefs-${crypto.randomUUID()}`);
    setMsg(r.ok ? { tone: "ok", text: t("prefsSaved") } : { tone: "error", text: r.error && e.has(r.error) ? e(r.error) : e("INTERNAL") });
  });
  const link = (on: boolean) => start(async () => {
    const r = await telegramLinkAction(on, `tg-${crypto.randomUUID()}`);
    if (!r.ok) { setMsg({ tone: "error", text: r.error && e.has(r.error) ? e(r.error) : e("INTERNAL") }); return; }
    setCode(on ? r.code || null : null);
    router.refresh();
  });
  const box = (k: "email" | "telegram") => (
    <label className="flex items-center gap-3"><input type="checkbox" className="size-5 accent-door" checked={p[k]}
      onChange={(ev) => setP({ ...p, [k]: ev.target.checked })} />{t(`channels.${k}`)}</label>
  );
  return (
    <section className="flex flex-col gap-3 panel p-4">
      <h2 className="text-xl font-semibold">{t("notifyTitle")}</h2>
      {box("email")}
      {box("telegram")}
      <details>
        <summary className="cursor-pointer">{t("appOnly")}</summary>
        <ul className="mt-2 flex flex-col gap-1 text-sm">
          {types.map((ty) => (
            <li key={ty}><label className="flex items-start gap-2"><input type="checkbox" className="mt-0.5 accent-door" checked={p.muted.includes(ty)}
              onChange={(ev) => setP({ ...p, muted: ev.target.checked ? [...p.muted, ty] : p.muted.filter((x) => x !== ty) })} />
              <span>{ty.replace(/_/g, " ")}</span></label></li>
          ))}
        </ul>
      </details>
      <Button type="button" onClick={save} disabled={pending} className="self-start">{t("prefsSave")}</Button>
      <div className="flex flex-col gap-2 border-t border-line pt-3">
        <p>{linked ? t("tgLinked") : t("tgNotLinked")}</p>
        {code && <Notice>{t("tgCode")} <strong className="ltr-island">/lier {code}</strong></Notice>}
        <Button type="button" variant="secondary" onClick={() => link(!linked)} disabled={pending} className="self-start">
          {linked ? t("tgUnlink") : t("tgLink")}</Button>
      </div>
      {msg && <Notice tone={msg.tone}>{msg.text}</Notice>}
    </section>
  );
}
