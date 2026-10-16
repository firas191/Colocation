import { randomUUID } from "node:crypto";
import { getFormatter, getTranslations, setRequestLocale } from "next-intl/server";
import { Link } from "@/i18n/navigation";
import { Button } from "@/components/ui/button";
import { Notice } from "@/components/ui/field";
import { requireMember } from "@/lib/server/guard";
import { api } from "@/lib/server/api";
import { clientIp } from "@/lib/server/viewer";
import { markAllReadAction } from "@/lib/actions/platform";

interface Item { id: number; type: string; params: Record<string, unknown>; created_at: string; read_at: string | null }

export async function generateMetadata() {
  const t = await getTranslations("notifications");
  return { title: t("title") };
}

export default async function Notifications({ params, searchParams }:
  { params: Promise<{ locale: string }>; searchParams: Promise<{ before?: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const me = await requireMember(locale);
  const { before } = await searchParams;
  const t = await getTranslations("notifications");
  const e = await getTranslations("errors");
  const fmt = await getFormatter();
  const r = await api<{ items: Item[]; next_before: number | null; unread: number }>("GET", "/v1/me/notifications",
    { userId: me.user_id, clientIp: await clientIp(), query: { limit: 20, before: before && /^\d+$/.test(before) ? before : undefined } });
  if (!r.ok) return <Notice tone="error">{e.has(r.error.code) ? e(r.error.code) : e("INTERNAL")}</Notice>;
  const text = (n: Item) => (t.has(`types.${n.type}`) ? t(`types.${n.type}`) : t("types.other", { type: n.type }));
  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <h1 className="text-3xl font-bold tracking-tight">{t("title")}</h1>
        {r.data.unread > 0 && (
          <form action={markAllReadAction.bind(null, locale)}>
            <input type="hidden" name="idem" value={`read-${randomUUID()}`} />
            <Button variant="secondary">{t("markAll")}</Button>
          </form>
        )}
      </div>
      {r.data.items.length === 0 ? <p className="text-ink-soft">{t("empty")}</p> : (
        <ul className="divide-y divide-line border-y border-line">
          {r.data.items.map((n) => (
            <li key={n.id} className="flex items-start gap-3 py-4">
              <span aria-hidden="true" className={`mt-2 size-2.5 shrink-0 rounded-full ${n.read_at ? "bg-transparent" : "bg-saffron"}`} />
              <div className="flex flex-col gap-0.5">
                <p className={n.read_at ? "" : "font-semibold"}>{text(n)}{!n.read_at && <span className="sr-only"> ({t("unread")})</span>}</p>
                <time dateTime={n.created_at} className="text-sm text-ink-soft">{fmt.dateTime(new Date(n.created_at), { dateStyle: "medium", timeStyle: "short" })}</time>
              </div>
            </li>
          ))}
        </ul>
      )}
      {r.data.next_before && <Link href={{ pathname: "/notifications", query: { before: String(r.data.next_before) } }}>{t("more")}</Link>}
    </div>
  );
}
