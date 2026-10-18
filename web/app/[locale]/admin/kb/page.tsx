// /admin/kb (platform P11, D-110): knowledge-base sources with their last ingestion step. Ingestion itself is started
// with POST /v1/admin/kb/ingest (phase 2), which stays an admin call.
import { notFound } from "next/navigation";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { Link } from "@/i18n/navigation";
import { Notice } from "@/components/ui/field";
import { requireMember } from "@/lib/server/guard";
import { api } from "@/lib/server/api";
import { clientIp } from "@/lib/server/viewer";

interface S { id: string; jurisdiction_code: string | null; title: string; url: string | null; source_type: string; reliability: number; status: string;
  retrieved_at: string; last_step: { step: string; status: string; at: string } | null }

export default async function Kb({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const me = await requireMember(locale);
  if (!me.flags.is_staff) notFound();
  const t = await getTranslations("admin");
  const e = await getTranslations("errors");
  const r = await api<{ items: S[] }>("GET", "/v1/admin/kb/sources", { userId: me.user_id, clientIp: await clientIp() });
  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-6">
      <Link href="/admin" className="link-back">{t("title")}</Link>
      <h1 className="page-title">{t("pages.kb")}</h1>
      {!r.ok ? <Notice tone="error">{e.has(r.error.code) ? e(r.error.code) : e("INTERNAL")}</Notice>
        : r.data.items.length === 0 ? <p className="text-ink-soft">{t("empty")}</p> : (
          <ul className="flex flex-col gap-2 text-sm" dir="ltr">
            {r.data.items.map((s) => (
              <li key={s.id} className="panel p-3">
                <strong>{s.jurisdiction_code || "GLOBAL"}</strong> · {s.title} · {s.source_type} · {s.reliability}/5 · {s.status}
                {s.url && <><br /><a href={s.url} rel="noreferrer">{s.url}</a></>}
                <br />{s.last_step ? `${s.last_step.step}: ${s.last_step.status} (${s.last_step.at.slice(0, 10)})` : t("neverIngested")}
              </li>
            ))}
          </ul>
        )}
    </div>
  );
}
