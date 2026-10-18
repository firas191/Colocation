// /flatmates/[id] (platform P7): one visible profile and its compatibility, factor by factor. Since D-115 a member can ask
// to get in touch (a conversation opens only if the other person accepts) and ask why the score is what it is.
import { notFound } from "next/navigation";
import { getFormatter, getTranslations, setRequestLocale } from "next-intl/server";
import { Link } from "@/i18n/navigation";
import { Notice } from "@/components/ui/field";
import { Avatar } from "@/components/ui/avatar";
import { Compat } from "@/components/flatmates/compat";
import { ContactRequest } from "@/components/flatmates/contact-request";
import { ExplainMatch } from "@/components/flatmates/explain-match";
import { requireMember } from "@/lib/server/guard";
import { api } from "@/lib/server/api";
import { clientIp } from "@/lib/server/viewer";
import type { FlatmateProfile } from "@/lib/flatmates";

export async function generateMetadata() {
  return { title: (await getTranslations("flatmates"))("title") };
}

export default async function Flatmate({ params }: { params: Promise<{ locale: string; id: string }> }) {
  const { locale, id } = await params;
  setRequestLocale(locale);
  const me = await requireMember(locale);
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const t = await getTranslations("flatmates");
  const e = await getTranslations("errors");
  const fmt = await getFormatter();
  const r = await api<FlatmateProfile>("GET", `/v1/flatmates/${id}`, { userId: me.user_id, clientIp: await clientIp() });
  if (!r.ok && r.status === 404) notFound();
  if (!r.ok) return <Notice tone="error">{e.has(r.error.code) ? e(r.error.code) : e("INTERNAL")}</Notice>;
  const f = r.data;
  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-8">
      <Link href="/flatmates" className="link-back">{t("back")}</Link>
      <header className="flex flex-wrap items-center gap-5">
        <Avatar name={f.user.display_name} size="lg" className="size-20 text-3xl" />
        <div className="flex min-w-0 flex-col gap-2">
          <h1 className="page-title">{f.user.display_name || t("unnamed")}</h1>
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span className="chip border-door/30 bg-door-soft text-door">{t(`seeking.${f.seeking}`)}</span>
            {f.areas.map((a) => <span key={a} className="chip">{a}</span>)}
          </div>
        </div>
      </header>
      <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <div className="flex flex-col gap-6">
          {f.headline && <p className="font-[family-name:var(--font-display)] text-xl [overflow-wrap:anywhere]">{f.headline}</p>}
          {f.move_in_from && <p className="text-ink-soft">{t("moveIn", { date: fmt.dateTime(new Date(f.move_in_from + "T00:00:00Z"), { dateStyle: "long", timeZone: "UTC" }) })}</p>}
          {f.bio && <p className="max-w-[70ch] whitespace-pre-line leading-relaxed [overflow-wrap:anywhere]">{f.bio}</p>}
          {f.compatibility && (
            <section aria-labelledby="compat-title" className="panel flex flex-col gap-3 p-5">
              <h2 id="compat-title" className="section-title">{t("compatTitle")}</h2>
              <Compat c={f.compatibility} full />
              <p className="text-sm text-ink-soft">{t("compatNote")}</p>
              {f.compatibility.score !== null && <ExplainMatch userId={id} />}
            </section>
          )}
        </div>
        {f.user.user_id !== me.user_id && (
          <aside className="lg:sticky lg:top-20 lg:self-start">
            <section aria-labelledby="contact-title" className="panel flex flex-col gap-3 p-5 shadow-[var(--shadow-lift)]">
              <h2 id="contact-title" className="section-title">{t("askContact")}</h2>
              <ContactRequest userId={id} />
            </section>
          </aside>
        )}
      </div>
    </div>
  );
}
