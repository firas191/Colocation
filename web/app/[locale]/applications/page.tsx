// /applications (platform P4): the caller's applications and those to their listings. The shared profile holds
// lifestyle fields only (PLATFORM_SPEC rule 2.6).
import { getFormatter, getTranslations, setRequestLocale } from "next-intl/server";
import { Link } from "@/i18n/navigation";
import { Empty, Notice } from "@/components/ui/field";
import { ApplicationActions } from "@/components/contact/application-actions";
import { requireMember } from "@/lib/server/guard";
import { api } from "@/lib/server/api";
import { clientIp } from "@/lib/server/viewer";
import { money } from "@/lib/listing";
import type { Application } from "@/lib/contact";

export async function generateMetadata() {
  return { title: (await getTranslations("contact"))("applicationsPage") };
}

export default async function Applications({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const me = await requireMember(locale);
  const t = await getTranslations("contact");
  const p = await getTranslations("profile");
  const e = await getTranslations("errors");
  const fmt = await getFormatter();
  const o = { userId: me.user_id, clientIp: await clientIp() };
  const [mine, received] = await Promise.all([
    api<{ items: Application[] }>("GET", "/v1/me/applications", o), api<{ items: Application[] }>("GET", "/v1/owner/applications", o)]);
  const day = (d: string) => fmt.dateTime(new Date(d + "T00:00:00Z"), { dateStyle: "long", timeZone: "UTC" });
  const exp = (c?: string | null) => me.jurisdictions.find((j) => j.currency === c)?.exponent ?? 2;
  const list = (r: typeof mine, title: string, id: string) => (
    <section aria-labelledby={id} className="flex flex-col gap-3">
      <h2 id={id} className="text-xl font-semibold">{title}</h2>
      {!r.ok ? <Notice tone="error">{e.has(r.error.code) ? e(r.error.code) : e("INTERNAL")}</Notice>
        : r.data.items.length === 0 ? <Empty>{t("applicationsEmpty")}</Empty> : (
          <ul className="flex flex-col gap-4">
            {r.data.items.map((a) => (
              <li key={a.application_id}>
                <article className="flex flex-col gap-2 panel p-4">
                  <p className="text-sm font-semibold text-ink-soft">{t(`appStatus.${a.status}`)}</p>
                  {a.listing && <h3 className="text-lg font-semibold [overflow-wrap:anywhere]"><Link href={`/listings/${a.listing.listing_id}`} className="link-title">{a.listing.title}</Link></h3>}
                  <p>{t("with", { name: a.other.display_name || t("signedNames.unknown") })}</p>
                  {a.message && <p className="whitespace-pre-line [overflow-wrap:anywhere]">{a.message}</p>}
                  {a.move_in_from && <p className="text-sm">{t("moveInOn", { date: day(a.move_in_from) })}</p>}
                  {a.role === "owner" && a.shared_profile && (
                    <div className="rounded-field bg-raised p-3 text-sm">
                      <p className="font-semibold">{t("sharedProfile")}</p>
                      {a.shared_profile.declared_preferences && Object.keys(a.shared_profile.declared_preferences).length > 0 && (
                        <p>{t("prefs")} : {Object.entries(a.shared_profile.declared_preferences)
                          .map(([k, v]) => `${p.has(k) ? p(k) : k} ${p.has(v) ? p(v) : v}`).join(" · ")}</p>)}
                      {a.shared_profile.languages && a.shared_profile.languages.length > 0 && <p>{t("languages")} : {a.shared_profile.languages.join(", ")}</p>}
                      {a.shared_profile.budget?.max_minor && <p>{t("budgetMax", { amount: money(locale, a.shared_profile.budget.max_minor,
                        a.shared_profile.budget.currency, exp(a.shared_profile.budget.currency)) || "" })}</p>}
                    </div>
                  )}
                  {a.role === "owner" && a.compatibility && a.compatibility.members > 0 && (
                    <p className="text-sm">{a.compatibility.score === null ? t("compatUnknown") : t("compatHousehold", { score: a.compatibility.score, members: a.compatibility.members })}</p>)}
                  <ApplicationActions a={a} />
                </article>
              </li>
            ))}
          </ul>
        )}
    </section>
  );
  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-8">
      <h1 className="page-title">{t("applicationsPage")}</h1>
      {list(received, t("received"), "received-title")}
      {list(mine, t("mine"), "mine-title")}
    </div>
  );
}
