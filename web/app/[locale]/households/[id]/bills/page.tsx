// /households/[id]/bills (platform P5): recurring rent and bills (reminded by the daily workflow), rent payments and
// their confirmation by the owner member.
import { notFound } from "next/navigation";
import { getFormatter, getTranslations, setRequestLocale } from "next-intl/server";
import { Link } from "@/i18n/navigation";
import { Field, Input, Notice } from "@/components/ui/field";
import { ActionButton } from "@/components/home/action-button";
import { FormAction } from "@/components/home/form-action";
import { HouseholdNav } from "@/components/home/household-nav";
import { RecurringEditor } from "@/components/home/recurring-editor";
import { requireMember } from "@/lib/server/guard";
import { api } from "@/lib/server/api";
import { clientIp } from "@/lib/server/viewer";
import { money, type Household } from "@/lib/home";

interface Rec { items: Array<{ item_id: string; kind: string; label: string; amount_minor: number | null; due_day: number; remind_days_before: number; next_due_on: string }> }
interface Pay { items: Array<{ payment_id: string; user: { display_name: string | null }; period: string; amount_minor: number; paid_on: string;
  confirmed: boolean; can_confirm: boolean; mine: boolean }> }

export default async function Bills({ params }: { params: Promise<{ locale: string; id: string }> }) {
  const { locale, id } = await params;
  setRequestLocale(locale);
  const me = await requireMember(locale);
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const t = await getTranslations("home");
  const e = await getTranslations("errors");
  const fmt = await getFormatter();
  const o = { userId: me.user_id, clientIp: await clientIp() };
  const [h, rec, pay] = await Promise.all([api<Household>("GET", `/v1/households/${id}`, o),
    api<Rec>("GET", `/v1/households/${id}/recurring`, o), api<Pay>("GET", `/v1/households/${id}/rent-payments`, o)]);
  if (!h.ok) notFound();
  const H = h.data;
  const box = "flex flex-col gap-3 panel p-4";
  const thisMonth = new Date().toISOString().slice(0, 7);
  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-6">
      <Link href={`/households/${id}`} className="link-back">{H.name}</Link>
      <h1 className="page-title">{t("nav.bills")}</h1>
      <HouseholdNav id={id} role={H.my_role} current="bills" />
      {!rec.ok || !pay.ok ? <Notice tone="error">{e(!rec.ok ? rec.error.code : !pay.ok ? pay.error.code : "INTERNAL")}</Notice> : (
        <>
          <section aria-labelledby="rec-title" className={box}>
            <h2 id="rec-title" className="section-title">{t("recurring")}</h2>
            <p className="text-sm text-ink-soft">{t("recurringLead")}</p>
            <RecurringEditor householdId={id} exponent={H.exponent} items={rec.data.items} />
          </section>
          <section aria-labelledby="pay-title" className={box}>
            <h2 id="pay-title" className="section-title">{t("rentPayments")}</h2>
            {pay.data.items.length === 0 ? <p className="text-ink-soft">{t("noPayment")}</p> : (
              <ul className="flex flex-col gap-2">
                {pay.data.items.map((p) => (
                  <li key={p.payment_id} className="flex flex-wrap items-center gap-3">
                    <span>{p.period} · {p.user.display_name || "?"} · <span className="ltr-island">{money(locale, p.amount_minor, H.currency, H.exponent)}</span> · {fmt.dateTime(new Date(p.paid_on + "T00:00:00Z"), { dateStyle: "medium", timeZone: "UTC" })}</span>
                    <span className={p.confirmed ? "text-olive" : "text-ink-soft"}>{p.confirmed ? t("confirmed") : t("notConfirmed")}</span>
                    {p.can_confirm && <ActionButton path={`/v1/rent-payments/${p.payment_id}/confirm`} body={{}} variant="primary">{t("confirm")}</ActionButton>}
                  </li>
                ))}
              </ul>
            )}
            {H.my_role === "flatmate" && (
              <FormAction path={`/v1/households/${id}/rent-payments`} kind="rent" exponent={H.exponent} submit={t("recordPayment")} done={t("saved")}>
                <div className="grid gap-3 sm:grid-cols-3">
                  <Field id="period" label={t("period")}><Input id="period" name="period" type="month" defaultValue={thisMonth} required /></Field>
                  <Field id="amount" label={`${t("amount")} (${H.currency})`}><Input id="amount" name="amount" inputMode="decimal" required /></Field>
                  <Field id="paid_on" label={t("paidOn")}><Input id="paid_on" name="paid_on" type="date" /></Field>
                </div>
              </FormAction>
            )}
          </section>
        </>
      )}
    </div>
  );
}
