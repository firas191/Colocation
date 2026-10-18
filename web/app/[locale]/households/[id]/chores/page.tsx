// /households/[id]/chores (platform P6): chores, whose turn it is, recent turns (flatmates only).
import { getFormatter, getTranslations, setRequestLocale } from "next-intl/server";
import { Link } from "@/i18n/navigation";
import { Field, Input, Notice, Select } from "@/components/ui/field";
import { ActionButton } from "@/components/home/action-button";
import { FormAction } from "@/components/home/form-action";
import { HouseholdNav } from "@/components/home/household-nav";
import { requireMember } from "@/lib/server/guard";
import { loadHousehold } from "@/lib/home-page";

type Ref = { user_id: string; display_name: string | null } | null;
interface Chores { items: Array<{ chore_id: string; title: string; frequency: string; next_due_on: string; active: boolean; next_person: Ref;
  assignments: Array<{ assignment_id: string; user: Ref; due_on: string; done: boolean; mine: boolean }> }> }

export default async function Chores({ params }: { params: Promise<{ locale: string; id: string }> }) {
  const { locale, id } = await params;
  setRequestLocale(locale);
  const me = await requireMember(locale);
  const t = await getTranslations("home");
  const e = await getTranslations("errors");
  const fmt = await getFormatter();
  const { h, d } = await loadHousehold<Chores>(me.user_id, id, "/chores");
  const day = (s: string) => fmt.dateTime(new Date(s + "T00:00:00Z"), { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });
  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-6">
      <Link href={`/households/${id}`} className="link-back">{h.name}</Link>
      <h1 className="page-title">{t("nav.chores")}</h1>
      <HouseholdNav id={id} role={h.my_role} current="chores" />
      {!d || !d.ok ? <Notice tone="error">{e(d && !d.ok ? d.error.code : "INTERNAL")}</Notice> : (
        <ul className="flex flex-col gap-4">
          {d.data.items.map((c) => (
            <li key={c.chore_id} className="flex flex-col gap-2 panel p-4">
              <h2 className="section-title">{c.title} <span className="text-sm font-normal text-ink-soft">· {t(`freq.${c.frequency}`)}</span></h2>
              {c.next_person && <p>{t("nextTurn", { name: c.next_person.display_name || "?", date: day(c.next_due_on) })}</p>}
              <ul className="flex flex-col gap-1 text-[0.95rem]">
                {c.assignments.map((a) => (
                  <li key={a.assignment_id} className="flex flex-wrap items-center gap-2">
                    <span>{day(a.due_on)} · {a.user?.display_name || "?"}</span>
                    {a.done ? <span className="text-olive">{t("done")}</span>
                      : <ActionButton path={`/v1/chore-assignments/${a.assignment_id}/done`} body={{}} variant="quiet">{t("markDone")}</ActionButton>}
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      )}
      <section aria-labelledby="new-chore" className="flex flex-col gap-3 panel p-4">
        <h2 id="new-chore" className="section-title">{t("newChore")}</h2>
        <FormAction path={`/v1/households/${id}/chores`} kind="chore" submit={t("add")}>
          <Field id="title" label={t("choreTitle")}><Input id="title" name="title" required maxLength={80} /></Field>
          <Field id="frequency" label={t("frequency")}>
            <Select id="frequency" name="frequency" defaultValue="weekly">{["daily", "weekly", "biweekly", "monthly"].map((f) => <option key={f} value={f}>{t(`freq.${f}`)}</option>)}</Select>
          </Field>
          <Field id="next_due_on" label={t("firstDate")}><Input id="next_due_on" name="next_due_on" type="date" /></Field>
        </FormAction>
      </section>
    </div>
  );
}
