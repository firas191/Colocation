// /households/[id] (platform P5): members, invites, the caller's balance, what is due next, announcements, leave.
import { notFound } from "next/navigation";
import { getFormatter, getTranslations, setRequestLocale } from "next-intl/server";
import { Link } from "@/i18n/navigation";
import { Check, Field, Input, Notice, Textarea } from "@/components/ui/field";
import { ActionButton } from "@/components/home/action-button";
import { FormAction } from "@/components/home/form-action";
import { Avatar } from "@/components/ui/avatar";
import { HouseholdNav } from "@/components/home/household-nav";
import { InviteButton } from "@/components/home/invite-button";
import { requireMember } from "@/lib/server/guard";
import { api } from "@/lib/server/api";
import { clientIp } from "@/lib/server/viewer";
import { money, type Household } from "@/lib/home";

export async function generateMetadata() {
  return { title: (await getTranslations("home"))("title") };
}

export default async function HouseholdPage({ params }: { params: Promise<{ locale: string; id: string }> }) {
  const { locale, id } = await params;
  setRequestLocale(locale);
  const me = await requireMember(locale);
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const t = await getTranslations("home");
  const e = await getTranslations("errors");
  const fmt = await getFormatter();
  const r = await api<Household>("GET", `/v1/households/${id}`, { userId: me.user_id, clientIp: await clientIp() });
  if (!r.ok && r.status === 404) notFound();
  if (!r.ok) return <Notice tone="error">{e.has(r.error.code) ? e(r.error.code) : e("INTERNAL")}</Notice>;
  const h = r.data;
  const box = "flex flex-col gap-3 panel p-4";
  const day = (d: string) => fmt.dateTime(new Date(d + "T00:00:00Z"), { dateStyle: "medium", timeZone: "UTC" });
  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-6">
      <Link href="/households" className="link-back">{t("back")}</Link>
      <header className="flex flex-col gap-1">
        <h1 className="page-title">{h.name}</h1>
        <p className="text-ink-soft">{t(`roles.${h.my_role}`)}</p>
      </header>
      <HouseholdNav id={id} role={h.my_role} current="overview" />
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
        <div className="flex flex-col gap-6">
          {h.my_balance_minor !== null && (
            <p className={`rounded-[var(--radius-photo)] p-6 font-[family-name:var(--font-display)] text-xl font-semibold sm:text-2xl ${h.my_balance_minor === 0 ? "bg-olive/10 text-olive"
              : h.my_balance_minor > 0 ? "bg-door-soft text-door" : "bg-bougain/10 text-bougain"}`}>
              {h.my_balance_minor === 0 ? t("balanceZero") : h.my_balance_minor > 0
                ? t("balanceOwed", { amount: money(locale, h.my_balance_minor, h.currency, h.exponent) })
                : t("balanceOwe", { amount: money(locale, -h.my_balance_minor, h.currency, h.exponent) })}
            </p>
          )}
          <section aria-labelledby="ann-title" className={box}>
            <h2 id="ann-title" className="section-title">{t("announcements")}</h2>
            {h.announcements.length === 0 ? <p className="text-ink-soft">{t("noAnnouncement")}</p> : (
              <ul className="flex flex-col gap-3">
                {h.announcements.map((a) => (
                  <li key={a.id} className={`flex gap-3 rounded-field p-3 ${a.pinned ? "bg-saffron/10 ring-1 ring-saffron/50" : "bg-raised"}`}>
                    <Avatar name={a.author?.display_name} size="sm" />
                    <div className="min-w-0">
                      <p className="whitespace-pre-line [overflow-wrap:anywhere]">{a.body}</p>
                      <p className="text-sm text-ink-soft">{a.author?.display_name || "?"} · {fmt.dateTime(new Date(a.created_at), { dateStyle: "medium", timeStyle: "short" })}</p>
                    </div>
                  </li>
                ))}
              </ul>
            )}
            <FormAction path={`/v1/households/${id}/announcements`} kind="announcement" submit={t("post")}>
              <Field id="ann-body" label={t("newAnnouncement")}><Textarea id="ann-body" name="body" required maxLength={2000} rows={2} /></Field>
              <Check id="ann-pin" name="pinned" label={t("pin")} />
            </FormAction>
          </section>
        </div>
        <div className="flex flex-col gap-6">
          {h.upcoming.length > 0 && (
            <section aria-labelledby="due-title" className={box}>
              <h2 id="due-title" className="section-title">{t("upcoming")}</h2>
              <ul className="flex flex-col divide-y divide-line">
                {h.upcoming.map((u) => (
                  <li key={u.item_id} className="flex items-baseline justify-between gap-3 py-2">
                    <span><span className="font-semibold">{u.label}</span> <span className="text-sm text-ink-soft">{day(u.due_on)}</span></span>
                    {u.amount && <span className="font-semibold ltr-island">{money(locale, u.amount.amount_minor, h.currency, h.exponent)}</span>}
                  </li>
                ))}
              </ul>
            </section>
          )}
          <section aria-labelledby="mem-title" className={box}>
            <h2 id="mem-title" className="section-title">{t("members")}</h2>
            <ul className="flex flex-col gap-3">
              {h.members.map((m) => (
                <li key={m.user_id} className="flex items-center gap-3">
                  <Avatar name={m.display_name} size="sm" />
                  <span>{m.display_name || "?"}{m.me ? ` (${t("you")})` : ""} <span className="text-sm text-ink-soft">{t(`roles.${m.role}`)}</span></span>
                </li>
              ))}
            </ul>
            <InviteButton householdId={id} locale={locale} />
          </section>
      <section aria-labelledby="room-title" className={box}>
        <h2 id="room-title" className="section-title">{t("roomPostTitle")}</h2>
        <p className="text-ink-soft">{t("roomPostLead")}</p>
        <FormAction path={`/v1/households/${id}/room-posts`} kind="roomPost" submit={t("roomPostSubmit")} then="/owner/listings/{listing_id}">
          <Field id="room-title-in" label={t("roomPostName")}><Input id="room-title-in" name="title" maxLength={120} /></Field>
        </FormAction>
      </section>
        </div>
      </div>
      <ActionButton path={`/v1/households/${id}/leave`} body={{}} variant="quiet" then="/households">{t("leave")}</ActionButton>
    </div>
  );
}
