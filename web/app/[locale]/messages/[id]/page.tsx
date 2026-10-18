// /messages/[id] (platform P4): a conversation, oldest message first, marked as read when opened.
import { randomUUID } from "node:crypto";
import { notFound } from "next/navigation";
import { getFormatter, getTranslations, setRequestLocale } from "next-intl/server";
import { Link } from "@/i18n/navigation";
import { Notice } from "@/components/ui/field";
import { Avatar } from "@/components/ui/avatar";
import { Thread } from "@/components/contact/thread";
import { requireMember } from "@/lib/server/guard";
import { api } from "@/lib/server/api";
import { clientIp } from "@/lib/server/viewer";
import type { Conversation, Message } from "@/lib/contact";

export async function generateMetadata() {
  return { title: (await getTranslations("contact"))("inboxTitle") };
}

export default async function ConversationPage({ params, searchParams }:
  { params: Promise<{ locale: string; id: string }>; searchParams: Promise<{ before?: string }> }) {
  const { locale, id } = await params;
  setRequestLocale(locale);
  const me = await requireMember(locale);
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const { before } = await searchParams;
  const t = await getTranslations("contact");
  const e = await getTranslations("errors");
  const fmt = await getFormatter();
  const o = { userId: me.user_id, clientIp: await clientIp() };
  const r = await api<{ conversation: Conversation; items: Message[]; next_before: number | null }>("GET", `/v1/conversations/${id}/messages`,
    { ...o, query: { limit: "30", before: before && /^\d+$/.test(before) ? before : undefined } });
  if (!r.ok && r.status === 404) notFound();
  if (!r.ok) return <Notice tone="error">{e.has(r.error.code) ? e(r.error.code) : e("INTERNAL")}</Notice>;
  if (r.data.conversation.unread > 0) await api("POST", `/v1/conversations/${id}/read`, { ...o, body: {}, idempotencyKey: `read-${randomUUID()}` });
  const c = r.data.conversation;
  const items = [...r.data.items].reverse();
  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6">
      <Link href="/messages" className="link-back">{t("back")}</Link>
      <header className="flex items-center gap-4 border-b border-line pb-5">
        <Avatar name={c.other?.display_name} size="lg" />
        <div className="flex min-w-0 flex-col gap-1">
          <h1 className="section-title text-2xl [overflow-wrap:anywhere]">{c.other?.display_name || t("signedNames.unknown")}</h1>
          {c.listing && <p className="text-ink-soft [overflow-wrap:anywhere]">
            {c.listing.status === "published" ? <Link href={`/listings/${c.listing.listing_id}`} className="link-action">{t("about", { title: c.listing.title || "" })}</Link>
              : t("about", { title: c.listing.title || "" })}</p>}
        </div>
      </header>
      {r.data.next_before && <Link href={`/messages/${id}?before=${r.data.next_before}`} className="btn btn-secondary self-start">{t("older")}</Link>}
      <ol className="flex flex-col gap-4" aria-label={t("inboxTitle")}>
        {items.map((m) => (
          <li key={m.id} className={m.mine ? "flex max-w-[80%] flex-col items-end gap-1 self-end" : "flex max-w-[80%] flex-col items-start gap-1 self-start"}>
            <p className={`whitespace-pre-line rounded-panel px-4 py-2.5 [overflow-wrap:anywhere] ${m.mine ? "rounded-ee-sm bg-door text-door-ink" : "rounded-ss-sm border border-line bg-paper"}`}>
              {m.body ?? <em>{t("deletedMessage")}</em>}
            </p>
            {!m.mine && (m.warnings || []).length > 0 && (
              <p role="note" className="rounded-field border border-saffron bg-saffron/10 px-3 py-2 text-sm">
                {t("scamWarning")} {(m.warnings || []).map((w) => (t.has(`warnings.${w}`) ? t(`warnings.${w}`) : w)).join(" ")}
              </p>
            )}
            <time dateTime={m.created_at} className="text-xs text-ink-soft">{m.mine ? `${t("you")} · ` : ""}{fmt.dateTime(new Date(m.created_at), { dateStyle: "short", timeStyle: "short" })}</time>
          </li>
        ))}
      </ol>
      {c.blocked && <Notice>{t("blockedNote")}</Notice>}
      <Thread conversationId={id} otherId={c.other?.user_id || null} blockedByMe={false} blocked={c.blocked}
        lastOtherMessage={[...items].reverse().find((m) => !m.mine)?.id ?? null} />
    </div>
  );
}
