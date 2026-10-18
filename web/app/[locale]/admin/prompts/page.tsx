// /admin/prompts (platform P11, D-110): the prompt registry, read-only (activation stays a file change, spec 9.5).
import { notFound } from "next/navigation";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { Link } from "@/i18n/navigation";
import { Notice } from "@/components/ui/field";
import { requireMember } from "@/lib/server/guard";
import { api } from "@/lib/server/api";
import { clientIp } from "@/lib/server/viewer";

interface P { name: string; agent: string; role: string; versions: Array<{ version: number; status: string; techniques: string[]; changelog: string | null }> | null }

export default async function Prompts({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const me = await requireMember(locale);
  if (!me.flags.is_staff) notFound();
  const t = await getTranslations("admin");
  const e = await getTranslations("errors");
  const r = await api<{ items: P[] }>("GET", "/v1/admin/prompts", { userId: me.user_id, clientIp: await clientIp() });
  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-6">
      <Link href="/admin" className="link-back">{t("title")}</Link>
      <h1 className="page-title">{t("pages.prompts")}</h1>
      {!r.ok ? <Notice tone="error">{e.has(r.error.code) ? e(r.error.code) : e("INTERNAL")}</Notice> : r.data.items.map((p) => (
        <section key={p.name} className="flex flex-col gap-2 panel p-3" dir="ltr">
          <h2 className="font-semibold">{p.name} · {p.agent}</h2>
          <p className="text-sm text-ink-soft">{p.role}</p>
          <ul className="text-sm">{(p.versions || []).map((v) => (
            <li key={v.version}><strong>v{v.version}</strong> · {v.status} · {v.techniques.join(", ")}{v.changelog ? ` · ${v.changelog}` : ""}</li>))}</ul>
        </section>
      ))}
    </div>
  );
}
