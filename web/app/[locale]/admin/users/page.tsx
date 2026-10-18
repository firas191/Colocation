// /admin/users (platform P11, D-110): staff, or users found by e-mail or name, and their role (admins; logged).
import { notFound } from "next/navigation";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { Link } from "@/i18n/navigation";
import { Input, Notice } from "@/components/ui/field";
import { Button } from "@/components/ui/button";
import { RoleForm } from "@/components/admin/admin-forms";
import { requireMember } from "@/lib/server/guard";
import { api } from "@/lib/server/api";
import { clientIp } from "@/lib/server/viewer";

export default async function Users({ params, searchParams }: { params: Promise<{ locale: string }>; searchParams: Promise<{ q?: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const me = await requireMember(locale);
  if (me.role !== "admin") notFound();
  const q = String((await searchParams).q || "").slice(0, 100);
  const t = await getTranslations("admin");
  const e = await getTranslations("errors");
  const r = await api<{ items: Array<{ user_id: string; email: string | null; display_name: string | null; role: string }> }>("GET", "/v1/admin/users",
    { userId: me.user_id, clientIp: await clientIp(), query: q ? { q } : {} });
  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-6">
      <Link href="/admin" className="link-back">{t("title")}</Link>
      <h1 className="page-title">{t("pages.users")}</h1>
      <form className="flex flex-wrap gap-2" role="search">
        <Input name="q" defaultValue={q} aria-label={t("findUser")} placeholder={t("findUser")} className="max-w-80" />
        <Button type="submit" variant="secondary">{t("find")}</Button>
      </form>
      {!r.ok ? <Notice tone="error">{e.has(r.error.code) ? e(r.error.code) : e("INTERNAL")}</Notice> : (
        <ul className="flex flex-col gap-3">
          {r.data.items.map((u) => (
            <li key={u.user_id} className="flex flex-col gap-2 panel p-3">
              <span>{u.display_name || "—"} · <span className="ltr-island">{u.email || "—"}</span></span>
              {u.user_id === me.user_id ? <span className="text-sm text-ink-soft">{t(`roles.${u.role}`)} ({t("you")})</span> : <RoleForm userId={u.user_id} role={u.role} />}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
