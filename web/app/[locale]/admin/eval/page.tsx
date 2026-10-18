// /admin/eval (platform P11, D-110): evaluation runs, newest first; a new run starts with POST /v1/admin/eval/runs.
import { notFound } from "next/navigation";
import { getFormatter, getTranslations, setRequestLocale } from "next-intl/server";
import { Link } from "@/i18n/navigation";
import { Notice } from "@/components/ui/field";
import { requireMember } from "@/lib/server/guard";
import { api } from "@/lib/server/api";
import { clientIp } from "@/lib/server/viewer";

interface R { run_id: string; dataset: { name?: string; version?: number } | null; config: Record<string, unknown>; started_at: string; finished_at: string | null; results: number }

export default async function Evals({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const me = await requireMember(locale);
  if (!me.flags.is_staff) notFound();
  const t = await getTranslations("admin");
  const e = await getTranslations("errors");
  const fmt = await getFormatter();
  const r = await api<{ items: R[] }>("GET", "/v1/admin/eval/runs", { userId: me.user_id, clientIp: await clientIp() });
  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-6">
      <Link href="/admin" className="link-back">{t("title")}</Link>
      <h1 className="page-title">{t("pages.eval")}</h1>
      {!r.ok ? <Notice tone="error">{e.has(r.error.code) ? e(r.error.code) : e("INTERNAL")}</Notice>
        : r.data.items.length === 0 ? <p className="text-ink-soft">{t("empty")}</p> : (
          <ul className="flex flex-col gap-2 text-sm" dir="ltr">
            {r.data.items.map((x) => (
              <li key={x.run_id} className="panel p-3">
                <strong>{x.dataset?.name || "?"} v{x.dataset?.version ?? "?"}</strong> · {fmt.dateTime(new Date(x.started_at), { dateStyle: "medium", timeStyle: "short" })}
                {" · "}{x.finished_at ? t("evalDone", { n: x.results }) : t("evalRunning")}
                <pre className="mt-1 overflow-x-auto text-xs">{JSON.stringify(x.config)}</pre>
              </li>
            ))}
          </ul>
        )}
    </div>
  );
}
