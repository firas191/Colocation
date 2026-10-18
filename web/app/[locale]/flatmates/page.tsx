// /flatmates (platform P7): visible flatmate profiles in the caller's country, best compatibility first (computed by the
// API). Profiles of people either side blocked never appear (row-level layer).
import { getTranslations, setRequestLocale } from "next-intl/server";
import { Link } from "@/i18n/navigation";
import { Notice } from "@/components/ui/field";
import { Avatar } from "@/components/ui/avatar";
import { Compat } from "@/components/flatmates/compat";
import { currentCountry } from "@/lib/server/country";
import { requireMember } from "@/lib/server/guard";
import { api } from "@/lib/server/api";
import { clientIp } from "@/lib/server/viewer";
import type { FlatmateProfile } from "@/lib/flatmates";

export async function generateMetadata() {
  return { title: (await getTranslations("flatmates"))("title") };
}

type Params = { seeking?: string; cursor?: string };

export default async function Flatmates({ params, searchParams }: { params: Promise<{ locale: string }>; searchParams: Promise<Params> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const me = await requireMember(locale);
  const sp = await searchParams;
  const t = await getTranslations("flatmates");
  const e = await getTranslations("errors");
  // only people of the country chosen in the header (D-118)
  const query: Record<string, string> = { jurisdiction: await currentCountry(me) };
  if (sp.seeking === "room" || sp.seeking === "flatmate") query.seeking = sp.seeking;
  if (sp.cursor && /^\d{1,6}$/.test(sp.cursor)) query.cursor = sp.cursor;
  const r = await api<{ items: FlatmateProfile[] }>("GET", "/v1/flatmates", { userId: me.user_id, clientIp: await clientIp(), query });
  const next = r.ok ? (r.meta.next_cursor as string | null | undefined) || null : null;
  const tab = (v: string, label: string) => (
    <Link href={v ? `/flatmates?seeking=${v}` : "/flatmates"} aria-current={(query.seeking || "") === v ? "page" : undefined}
      className={`inline-flex min-h-9 items-center rounded-full px-4 text-sm font-semibold no-underline transition-colors ${(query.seeking || "") === v ? "bg-door text-door-ink" : "text-ink hover:bg-raised"}`}>{label}</Link>
  );
  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div className="flex flex-col gap-2">
          <h1 className="page-title">{t("title")}</h1>
          <p className="max-w-[60ch] text-ink-soft">{t("lead")}</p>
        </div>
        <p className="flex flex-wrap gap-2">
          <Link href="/flatmates/me" className="btn btn-primary">{t("myProfile")}</Link>
          <Link href="/contact-requests" className="btn btn-secondary">{t("contactRequests")}</Link>
          <Link href="/saved-searches" className="btn btn-secondary">{t("savedSearches")}</Link>
        </p>
      </header>
      <nav aria-label={t("filter")} className="inline-flex flex-wrap gap-1 self-start rounded-full border border-line bg-paper p-1">
        {tab("", t("all"))}{tab("room", t("seekingRoom"))}{tab("flatmate", t("seekingFlatmate"))}
      </nav>
      {!r.ok ? <Notice tone="error">{e.has(r.error.code) ? e(r.error.code) : e("INTERNAL")}</Notice>
        : r.data.items.length === 0 ? <p className="text-ink-soft">{t("empty")}</p> : (
          <ul className="grid gap-5 sm:grid-cols-2 xl:grid-cols-3">
            {r.data.items.map((f) => (
              <li key={f.user.user_id}>
                <article className="panel group relative flex h-full flex-col gap-4 p-5 transition-shadow hover:shadow-[var(--shadow-lift)]">
                  <div className="flex items-center gap-3">
                    <Avatar name={f.user.display_name} size="lg" />
                    <div className="flex min-w-0 flex-col gap-1">
                      <h2 className="text-lg font-semibold [overflow-wrap:anywhere]">
                        <Link href={`/flatmates/${f.user.user_id}`} className="text-ink no-underline after:absolute after:inset-0 group-hover:text-door">{f.user.display_name || t("unnamed")}</Link>
                      </h2>
                      <span className="chip min-h-6 self-start border-door/30 bg-door-soft px-2 text-xs text-door">{t(`seeking.${f.seeking}`)}</span>
                    </div>
                  </div>
                  {f.headline && <p className="[overflow-wrap:anywhere]">{f.headline}</p>}
                  {f.areas.length > 0 && <ul className="flex flex-wrap gap-1.5">{f.areas.map((a) => <li key={a} className="rounded-full bg-raised px-2.5 py-0.5 text-xs">{a}</li>)}</ul>}
                  {f.compatibility && <div className="mt-auto border-t border-line pt-4"><Compat c={f.compatibility} /></div>}
                </article>
              </li>
            ))}
          </ul>
        )}
      {next && <Link href={`/flatmates?${new URLSearchParams({ ...(query.seeking ? { seeking: query.seeking } : {}), cursor: next })}`} className="btn btn-secondary self-start">{t("more")}</Link>}
    </div>
  );
}
