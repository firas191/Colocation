// /households/[id]/move-out (platform P10, D-109): a flatmate's move-out checklist (some items ticked by hand, the
// others computed by the API), the deposits, and leaving the household (refused while the balance is not zero unless
// the person says they know). The checklist has no legal item: no notice rule was read from a primary source for it.
import { notFound } from "next/navigation";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { Link } from "@/i18n/navigation";
import { Field, Input, Notice, Textarea } from "@/components/ui/field";
import { ActionButton } from "@/components/home/action-button";
import { FormAction } from "@/components/home/form-action";
import { HouseholdNav } from "@/components/home/household-nav";
import { requireMember } from "@/lib/server/guard";
import { api } from "@/lib/server/api";
import { clientIp } from "@/lib/server/viewer";
import { money, type Household } from "@/lib/home";

interface Item { key: string; kind: "manual" | "computed"; done: boolean; balance_minor?: number }
interface Dep { user: { user_id: string; display_name: string | null }; amount: { amount_minor: number }; paid_on: string | null; held_by: string;
  returned: { amount_minor: number } | null; returned_on: string | null; deductions: Array<{ reason: string; amount_minor: number }>; kept_minor: number | null }

export default async function MoveOut({ params }: { params: Promise<{ locale: string; id: string }> }) {
  const { locale, id } = await params;
  setRequestLocale(locale);
  const me = await requireMember(locale);
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const t = await getTranslations("moveout");
  const e = await getTranslations("errors");
  const o = { userId: me.user_id, clientIp: await clientIp() };
  const h = await api<Household>("GET", `/v1/households/${id}`, o);
  if (!h.ok) notFound();
  const H = h.data;
  const [mo, deps] = await Promise.all([
    H.my_role === "flatmate" ? api<{ move_out: { planned_on: string; items: Item[] } | null }>("GET", `/v1/households/${id}/move-out`, o) : Promise.resolve(null),
    api<{ items: Dep[] }>("GET", `/v1/households/${id}/deposits`, o)]);
  const box = "flex flex-col gap-3 panel p-4";
  const m = mo && mo.ok ? mo.data.move_out : null;
  const bal = m?.items.find((i) => i.key === "balance_settled")?.balance_minor ?? 0;
  const amount = (x: number | null | undefined) => money(locale, x, H.currency, H.exponent);
  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-6">
      <Link href={`/households/${id}`} className="link-back">{H.name}</Link>
      <h1 className="page-title">{t("title")}</h1>
      <HouseholdNav id={id} role={H.my_role} current="moveout" />
      {H.my_role === "flatmate" && (
        <section aria-labelledby="mo-title" className={box}>
          <h2 id="mo-title" className="section-title">{t("checklist")}</h2>
          {!m ? (
            <FormAction path={`/v1/households/${id}/move-out`} kind="moveOut" submit={t("start")} resetOnDone={false}>
              <Field id="mo-date" label={t("plannedOn")}><Input id="mo-date" name="planned_on" type="date" required /></Field>
            </FormAction>
          ) : (
            <>
              <p>{t("plannedFor", { date: m.planned_on })}</p>
              <ul className="flex flex-col gap-2">
                {m.items.map((i) => (
                  <li key={i.key} className="flex flex-wrap items-center gap-3">
                    <span aria-hidden="true">{i.done ? "✓" : "○"}</span>
                    <span>{t(`items.${i.key}`)}{i.key === "balance_settled" && !i.done ? ` (${amount(i.balance_minor)})` : ""}</span>
                    {i.kind === "manual" && (
                      <ActionButton method="PATCH" path={`/v1/households/${id}/move-out/${i.key}`} body={{ done: !i.done }} variant="quiet">
                        {i.done ? t("undo") : t("tick")}</ActionButton>)}
                    {i.key === "exit_inventory" && !i.done && <Link href={`/households/${id}/documents`} className="link-action">{t("toDocuments")}</Link>}
                  </li>
                ))}
              </ul>
            </>
          )}
        </section>
      )}
      <section aria-labelledby="dep-title" className={box}>
        <h2 id="dep-title" className="section-title">{t("deposits")}</h2>
        {!deps.ok ? <Notice tone="error">{e.has(deps.error.code) ? e(deps.error.code) : e("INTERNAL")}</Notice>
          : deps.data.items.length === 0 ? <p className="text-ink-soft">{t("noDeposit")}</p> : (
            <ul className="flex flex-col gap-2">
              {deps.data.items.map((d) => (
                <li key={d.user.user_id}>
                  <strong>{d.user.display_name || "—"}</strong> · {amount(d.amount.amount_minor)} · {t(`heldBy.${d.held_by}`)}
                  {d.returned ? ` · ${t("returned", { amount: amount(d.returned.amount_minor), date: d.returned_on || "" })}` : ""}
                  {d.deductions.length > 0 && <ul className="ms-4 text-sm">{d.deductions.map((x, i) => <li key={i}>{x.reason} : {amount(x.amount_minor)}</li>)}</ul>}
                </li>
              ))}
            </ul>
          )}
        {H.my_role === "owner" && <p className="text-sm text-ink-soft">{t("recordLead")}</p>}
        {H.my_role === "owner" && H.members.filter((x) => x.role === "flatmate" && x.status !== "left").map((x) => (
          <details key={x.user_id} className="rounded-field border border-line p-3">
            <summary className="cursor-pointer">{t("recordFor", { name: x.display_name || "—" })}</summary>
            <div className="mt-3">
              <FormAction path={`/v1/households/${id}/deposits/${x.user_id}`} method="PUT" kind="deposit" exponent={H.exponent}
                submit={t("record")} done={t("recorded")} resetOnDone={false}>
                <Field id={`dep-amount-${x.user_id}`} label={t("amount")}><Input id={`dep-amount-${x.user_id}`} name="amount" inputMode="decimal" required /></Field>
                <Field id={`dep-paid-${x.user_id}`} label={t("paidOn")}><Input id={`dep-paid-${x.user_id}`} name="paid_on" type="date" /></Field>
                <Field id={`dep-ret-${x.user_id}`} label={t("returnedAmount")}><Input id={`dep-ret-${x.user_id}`} name="returned" inputMode="decimal" /></Field>
                <Field id={`dep-reton-${x.user_id}`} label={t("returnedOn")}><Input id={`dep-reton-${x.user_id}`} name="returned_on" type="date" /></Field>
                <Field id={`dep-ded-${x.user_id}`} label={t("deductions")} hint={t("deductionsHint")}><Textarea id={`dep-ded-${x.user_id}`} name="deductions" rows={3} /></Field>
              </FormAction>
            </div>
          </details>
        ))}
      </section>
      {H.my_role === "flatmate" && (
        <section aria-labelledby="leave-title" className={box}>
          <h2 id="leave-title" className="section-title">{t("leaveTitle")}</h2>
          {bal !== 0 && <Notice>{t("balanceWarning", { amount: amount(Math.abs(bal)), dir: bal < 0 ? "owe" : "owed" })}</Notice>}
          <ActionButton path={`/v1/households/${id}/leave`} body={{ acknowledge_balance: bal !== 0 }} variant="quiet" then="/households">
            {bal !== 0 ? t("leaveAnyway") : t("leave")}</ActionButton>
        </section>
      )}
    </div>
  );
}
