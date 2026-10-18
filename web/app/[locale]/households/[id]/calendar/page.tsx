// /households/[id]/calendar (platform P6): the next 30 days: own events plus rent and bill dates, chore turns, move
// dates and the caller's visits, computed by the API.
import { getFormatter, getTranslations, setRequestLocale } from "next-intl/server";
import { Link } from "@/i18n/navigation";
import { Check, Field, Input, Notice } from "@/components/ui/field";
import { ActionButton } from "@/components/home/action-button";
import { FormAction } from "@/components/home/form-action";
import { HouseholdNav } from "@/components/home/household-nav";
import { requireMember } from "@/lib/server/guard";
import { loadHousehold } from "@/lib/home-page";

interface Cal { items: Array<{ kind: string; id: string; title: string; date: string; starts_at?: string; all_day?: boolean; can_delete?: boolean;
  user?: { display_name: string | null } }> }

export default async function Calendar({ params }: { params: Promise<{ locale: string; id: string }> }) {
  const { locale, id } = await params;
  setRequestLocale(locale);
  const me = await requireMember(locale);
  const t = await getTranslations("home");
  const e = await getTranslations("errors");
  const fmt = await getFormatter();
  const { h, d } = await loadHousehold<Cal>(me.user_id, id, "/calendar");
  const day = (s: string) => fmt.dateTime(new Date(s + "T00:00:00Z"), { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" });
  const byDay = new Map<string, Cal["items"]>();
  if (d && d.ok) for (const x of d.data.items) byDay.set(x.date, [...(byDay.get(x.date) || []), x]);
  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-6">
      <Link href={`/households/${id}`} className="link-back">{h.name}</Link>
      <h1 className="page-title">{t("nav.calendar")}</h1>
      <HouseholdNav id={id} role={h.my_role} current="calendar" />
      {!d || !d.ok ? <Notice tone="error">{e(d && !d.ok ? d.error.code : "INTERNAL")}</Notice> : byDay.size === 0 ? <p className="text-ink-soft">{t("nothingSoon")}</p> : (
        <ol className="flex flex-col gap-4">
          {[...byDay.entries()].map(([date, xs]) => (
            <li key={date}>
              <h2 className="font-semibold">{day(date)}</h2>
              <ul className="mt-1 flex flex-col gap-1">
                {xs.map((x) => (
                  <li key={`${x.kind}-${x.id}`} className="flex flex-wrap items-center gap-2">
                    <span className="rounded-full bg-raised px-2 text-xs">{t(`calKinds.${x.kind}`)}</span>
                    <span>{x.title}{x.user ? ` · ${x.user.display_name || "?"}` : ""}{x.starts_at && !x.all_day ? ` · ${fmt.dateTime(new Date(x.starts_at), { timeStyle: "short" })}` : ""}</span>
                    {x.can_delete && <ActionButton method="DELETE" path={`/v1/households/${id}/events/${x.id}`} variant="quiet">{t("delete")}</ActionButton>}
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ol>
      )}
      <section aria-labelledby="new-ev" className="flex flex-col gap-3 panel p-4">
        <h2 id="new-ev" className="section-title">{t("newEvent")}</h2>
        <FormAction path={`/v1/households/${id}/events`} kind="event" submit={t("add")}>
          <Field id="ev-title" label={t("eventTitle")}><Input id="ev-title" name="title" required maxLength={80} /></Field>
          <Field id="ev-start" label={t("start")}><Input id="ev-start" name="starts_at" type="datetime-local" required /></Field>
          <Check id="ev-allday" name="all_day" label={t("allDay")} />
        </FormAction>
      </section>
    </div>
  );
}
