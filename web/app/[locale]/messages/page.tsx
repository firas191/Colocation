// /messages (platform P4): GET /v1/conversations, latest first.
import { getFormatter, getTranslations, setRequestLocale } from "next-intl/server";
import { Link } from "@/i18n/navigation";
import { Empty, Notice } from "@/components/ui/field";
import { Avatar } from "@/components/ui/avatar";
import { requireMember } from "@/lib/server/guard";
import { api } from "@/lib/server/api";
import { clientIp } from "@/lib/server/viewer";
import type { Conversation } from "@/lib/contact";

export async function generateMetadata() {
  return { title: (await getTranslations("contact"))("inboxTitle") };
}

export default async function Inbox({ params, searchParams }: { params: Promise<{ locale: string }>; searchParams: Promise<{ cursor?: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const me = await requireMember(locale);
  const { cursor } = await searchParams;
  const t = await getTranslations("contact");
  const e = await getTranslations("errors");
  const fmt = await getFormatter();
  const r = await api<{ items: Conversation[] }>("GET", "/v1/conversations", { userId: me.user_id, clientIp: await clientIp(),
    query: { limit: "20", cursor: cursor && /^\d+_[0-9a-f-]{36}$/.test(cursor) ? cursor : undefined } });
  if (!r.ok) return <Notice tone="error">{e.has(r.error.code) ? e(r.error.code) : e("INTERNAL")}</Notice>;
  const next = r.meta.next_cursor as string | null;
  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6">
      <h1 className="page-title">{t("inboxTitle")}</h1>
      {r.data.items.length === 0 ? <Empty action={<Link href="/search" className="btn btn-primary">{(await getTranslations("nav"))("search")}</Link>}>{t("inboxEmpty")}</Empty> : (
        <ul className="panel divide-y divide-line overflow-hidden">
          {r.data.items.map((c) => (
            <li key={c.conversation_id}>
              <Link href={`/messages/${c.conversation_id}`} className="flex items-start gap-4 px-4 py-4 text-ink no-underline transition-colors hover:bg-raised">
                <Avatar name={c.other?.display_name} />
                <span className="flex min-w-0 flex-1 flex-col gap-1">
                <span className="flex flex-wrap items-baseline justify-between gap-2">
                  <span className={c.unread ? "font-bold" : "font-semibold"}>{c.other?.display_name || t("signedNames.unknown")}</span>
                  <time dateTime={c.last_message_at} className="text-sm text-ink-soft">{fmt.dateTime(new Date(c.last_message_at), { dateStyle: "medium", timeStyle: "short" })}</time>
                </span>
                {c.listing && <span className="text-sm text-ink-soft [overflow-wrap:anywhere]">{t("about", { title: c.listing.title || "" })}</span>}
                <span className="text-[0.95rem] [overflow-wrap:anywhere]">
                  {c.last_message ? `${c.last_message.mine ? `${t("you")} : ` : ""}${c.last_message.excerpt ?? t("deletedMessage")}` : ""}
                </span>
                {c.unread > 0 && <span className="self-start rounded-full bg-bougain px-2 text-xs font-bold text-bougain-ink">{t("unread", { count: c.unread })}</span>}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
      {next && <Link href={`/messages?cursor=${encodeURIComponent(next)}`} rel="next" className="btn btn-secondary self-start">{t("older")}</Link>}
    </div>
  );
}
