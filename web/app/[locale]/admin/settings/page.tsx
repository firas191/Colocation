// /admin/settings (platform P11, D-110): the settings of the allowlist, with their type; each change is logged.
import { notFound } from "next/navigation";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { Link } from "@/i18n/navigation";
import { Notice } from "@/components/ui/field";
import { SettingForm } from "@/components/admin/admin-forms";
import { requireMember } from "@/lib/server/guard";
import { api } from "@/lib/server/api";
import { clientIp } from "@/lib/server/viewer";

export default async function Settings({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const me = await requireMember(locale);
  if (me.role !== "admin") notFound();
  const t = await getTranslations("admin");
  const e = await getTranslations("errors");
  const r = await api<{ items: Array<{ key: string; value: unknown; type: string; description: string | null }> }>("GET", "/v1/admin/settings",
    { userId: me.user_id, clientIp: await clientIp() });
  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-6">
      <Link href="/admin" className="link-back">{t("title")}</Link>
      <h1 className="page-title">{t("pages.settings")}</h1>
      {!r.ok ? <Notice tone="error">{e.has(r.error.code) ? e(r.error.code) : e("INTERNAL")}</Notice> : (
        <ul className="grid gap-4 md:grid-cols-2">
          {r.data.items.map((s) => (
            <li key={s.key} className="flex flex-col gap-1 panel p-3">
              <code className="ltr-island text-sm font-semibold">{s.key}</code>
              {s.description && <p className="text-sm text-ink-soft">{s.description}</p>}
              <SettingForm k={s.key} type={s.type} value={s.value} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
