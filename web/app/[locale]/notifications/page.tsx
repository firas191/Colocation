import { randomUUID } from "node:crypto";
import { getFormatter, getTranslations, setRequestLocale } from "next-intl/server";
import { Link } from "@/i18n/navigation";
import { Button } from "@/components/ui/button";
import { Empty, Notice } from "@/components/ui/field";
import { requireMember } from "@/lib/server/guard";
import { api } from "@/lib/server/api";
import { clientIp } from "@/lib/server/viewer";
import { markAllReadAction } from "@/lib/actions/platform";

interface Item { id: number; type: string; params: Record<string, unknown>; link_kind?: string | null; link_id?: string | null;
  created_at: string; read_at: string | null }

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
  // the notification's parameters fill its sentence (a name, a title); a missing one shows as an empty string
  const vals = (n: Item) => Object.fromEntries(Object.entries(n.params || {}).map(([k, v]) => [k, v === null || v === undefined ? "" : String(v)]));
  const text = (n: Item) => (t.has(`types.${n.type}`) ? t(`types.${n.type}`, { from: "", title: "", listing_title: "", name: "", label: "", due_on: "", period: "", ...vals(n) })
    : t("types.other", { type: n.type }));
  // where the notification leads (platform P3, P4)
  const href = (n: Item) => (n.link_kind === "conversation" && n.link_id ? `/messages/${n.link_id}` : n.link_kind === "visit" ? "/visits"
    : n.link_kind === "application" ? "/applications" : n.link_kind === "listing" && n.link_id ? `/owner/listings/${n.link_id}`
    : n.link_kind === "household" && n.link_id ? `/households/${n.link_id}` : n.link_kind === "household_invite" ? "/households"
    : n.link_kind === "saved_search" ? "/saved-searches" : n.link_kind === "contact_request" ? "/contact-requests" : null);
  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <h1 className="page-title">{t("title")}</h1>
        {r.data.unread > 0 && (
          <form action={markAllReadAction.bind(null, locale)}>
            <input type="hidden" name="idem" value={`read-${randomUUID()}`} />
            <Button variant="secondary">{t("markAll")}</Button>
          </form>
        )}
      </div>
      {r.data.items.length === 0 ? <Empty>{t("empty")}</Empty> : (
        <ul className="panel divide-y divide-line overflow-hidden">
          {r.data.items.map((n) => (
            <li key={n.id} className={`relative flex items-start gap-3 px-4 py-4 transition-colors hover:bg-raised ${n.read_at ? "" : "bg-door-soft/50"}`}>
              <span aria-hidden="true" className={`mt-2 size-2.5 shrink-0 rounded-full ${n.read_at ? "bg-line" : "bg-bougain"}`} />
              <div className="flex flex-col gap-0.5">
                <p className={n.read_at ? "" : "font-semibold"}>{href(n) ? <Link href={href(n)!} className="text-ink no-underline after:absolute after:inset-0 hover:text-door">{text(n)}</Link> : text(n)}{!n.read_at && <span className="sr-only"> ({t("unread")})</span>}</p>
                <time dateTime={n.created_at} className="text-sm text-ink-soft">{fmt.dateTime(new Date(n.created_at), { dateStyle: "medium", timeStyle: "short" })}</time>
              </div>
            </li>
          ))}
        </ul>
      )}
      {r.data.next_before && <Link href={{ pathname: "/notifications", query: { before: String(r.data.next_before) } }} className="btn btn-secondary self-start">{t("more")}</Link>}
    </div>
  );
}
