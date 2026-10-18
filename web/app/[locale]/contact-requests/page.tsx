// /contact-requests (platform P12, D-115): requests to get in touch, received and sent. Accepting opens a conversation.
import { getFormatter, getTranslations, setRequestLocale } from "next-intl/server";
import { Link } from "@/i18n/navigation";
import { Empty, Notice } from "@/components/ui/field";
import { Avatar } from "@/components/ui/avatar";
import { RequestActions } from "@/components/flatmates/request-actions";
import { requireMember } from "@/lib/server/guard";
import { api } from "@/lib/server/api";
import { clientIp } from "@/lib/server/viewer";
import type { UserRef } from "@/lib/contact";

interface Req { request_id: string; direction: "sent" | "received"; other: UserRef; note: string | null;
  status: "pending" | "accepted" | "refused" | "cancelled" | "expired"; conversation_id: string | null; created_at: string;
  actions: { accept: boolean; refuse: boolean; cancel: boolean } }

export async function generateMetadata() {
  return { title: (await getTranslations("flatmates"))("contactRequests") };
}

export default async function ContactRequests({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const me = await requireMember(locale);
  const t = await getTranslations("flatmates");
  const e = await getTranslations("errors");
  const fmt = await getFormatter();
  const ip = await clientIp();
  const lists = await Promise.all((["received", "sent"] as const).map((d) =>
    api<{ items: Req[] }>("GET", "/v1/me/contact-requests", { userId: me.user_id, clientIp: ip, query: { direction: d } })));
  const bad = lists.find((r) => !r.ok);
  if (bad && !bad.ok) return <Notice tone="error">{e.has(bad.error.code) ? e(bad.error.code) : e("INTERNAL")}</Notice>;
  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6">
      <Link href="/flatmates" className="link-back">{t("back")}</Link>
      <h1 className="page-title">{t("contactRequests")}</h1>
      {(["received", "sent"] as const).map((d, i) => {
        const r = lists[i];
        const items = r.ok ? r.data.items : [];
        return (
          <section key={d} aria-labelledby={`cr-${d}`} className="flex flex-col gap-3">
            <h2 id={`cr-${d}`} className="section-title">{t(d)}</h2>
            {items.length === 0 ? <Empty>{t("noRequests")}</Empty> : (
              <ul className="flex flex-col gap-3">
                {items.map((x) => (
                  <li key={x.request_id} className="panel flex items-start gap-4 p-4">
                    <Avatar name={x.other.display_name} />
                    <div className="flex min-w-0 flex-1 flex-col gap-2">
                    <p>
                      <Link href={`/flatmates/${x.other.user_id}`} className="link-title">{x.other.display_name || t("unnamed")}</Link>
                      {" "}· {t(`status.${x.status}`)} · {fmt.dateTime(new Date(x.created_at), { dateStyle: "medium" })}
                    </p>
                    {x.note && <p className="whitespace-pre-line [overflow-wrap:anywhere]">{x.note}</p>}
                    {x.conversation_id && <Link href={`/messages/${x.conversation_id}`} className="link-action">{t("openConversation")}</Link>}
                    <RequestActions id={x.request_id} actions={x.actions} />
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>
        );
      })}
    </div>
  );
}
