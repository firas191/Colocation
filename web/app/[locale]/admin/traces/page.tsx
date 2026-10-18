// /admin/traces (platform P11, D-110): one request's trace by its request id (GET /v1/admin/traces/{id}, admins).
import { notFound } from "next/navigation";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { Link } from "@/i18n/navigation";
import { Button } from "@/components/ui/button";
import { Input, Notice } from "@/components/ui/field";
import { requireMember } from "@/lib/server/guard";
import { api } from "@/lib/server/api";
import { clientIp } from "@/lib/server/viewer";

export default async function Traces({ params, searchParams }: { params: Promise<{ locale: string }>; searchParams: Promise<{ id?: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const me = await requireMember(locale);
  if (!me.flags.is_staff) notFound();
  const id = String((await searchParams).id || "").trim();
  const t = await getTranslations("admin");
  const e = await getTranslations("errors");
  const r = /^[0-9a-f-]{36}$/i.test(id) ? await api<unknown>("GET", `/v1/admin/traces/${id}`, { userId: me.user_id, clientIp: await clientIp() }) : null;
  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-6">
      <Link href="/admin" className="link-back">{t("title")}</Link>
      <h1 className="page-title">{t("pages.traces")}</h1>
      <form className="flex flex-wrap gap-2">
        <Input name="id" defaultValue={id} aria-label={t("requestId")} placeholder={t("requestId")} className="ltr-island max-w-96" />
        <Button type="submit" variant="secondary">{t("find")}</Button>
      </form>
      {me.role !== "admin" && <Notice>{t("tracesAdminOnly")}</Notice>}
      {r && (!r.ok ? <Notice tone="error">{e.has(r.error.code) ? e(r.error.code) : e("INTERNAL")}</Notice>
        : <pre className="overflow-x-auto panel p-3 text-xs" dir="ltr">{JSON.stringify(r.data, null, 2)}</pre>)}
    </div>
  );
}
