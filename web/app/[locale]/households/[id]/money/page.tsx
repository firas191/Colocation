// /households/[id]/money (platform P5): expenses, balances, suggested settlements. Flatmates only (7.3).
import { notFound } from "next/navigation";
import { getFormatter, getTranslations, setRequestLocale } from "next-intl/server";
import { Link } from "@/i18n/navigation";
import { Notice } from "@/components/ui/field";
import { ActionButton } from "@/components/home/action-button";
import { ExpenseForm } from "@/components/home/expense-form";
import { Avatar } from "@/components/ui/avatar";
import { HouseholdNav } from "@/components/home/household-nav";
import { requireMember } from "@/lib/server/guard";
import { api } from "@/lib/server/api";
import { clientIp } from "@/lib/server/viewer";
import { money, type Household } from "@/lib/home";

interface Ref { user_id: string; display_name: string | null }
interface Exp { expense_id: string; label: string; category: string; spent_on: string; amount: { amount_minor: number }; paid_by: Ref;
  shares: Array<Ref & { share_minor: number }>; can_delete: boolean }
interface Bal { balances: Array<Ref & { balance_minor: number; me: boolean }>; suggested: Array<{ from: Ref; to: Ref; amount_minor: number }> }

export default async function Money({ params }: { params: Promise<{ locale: string; id: string }> }) {
  const { locale, id } = await params;
  setRequestLocale(locale);
  const me = await requireMember(locale);
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const t = await getTranslations("home");
  const e = await getTranslations("errors");
  const fmt = await getFormatter();
  const o = { userId: me.user_id, clientIp: await clientIp() };
  const [h, ex, bal] = await Promise.all([api<Household>("GET", `/v1/households/${id}`, o),
    api<{ items: Exp[] }>("GET", `/v1/households/${id}/expenses`, o), api<Bal>("GET", `/v1/households/${id}/balances`, o)]);
  if (!h.ok) notFound();
  const H = h.data;
  const m = (x: number) => money(locale, x, H.currency, H.exponent);
  const box = "flex flex-col gap-3 panel p-4";
  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-6">
      <Link href={`/households/${id}`} className="link-back">{H.name}</Link>
      <h1 className="page-title">{t("nav.money")}</h1>
      <HouseholdNav id={id} role={H.my_role} current="money" />
      {!ex.ok || !bal.ok ? <Notice tone="error">{e(!ex.ok ? ex.error.code : !bal.ok ? bal.error.code : "INTERNAL")}</Notice> : (
        <>
          <section aria-labelledby="bal-title" className={box}>
            <h2 id="bal-title" className="section-title">{t("balances")}</h2>
            <ul className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
              {bal.data.balances.map((b) => (
                <li key={b.user_id} className="flex items-center gap-3 rounded-field bg-raised px-3 py-2.5">
                  <Avatar name={b.display_name} size="sm" />
                  <span className="min-w-0 flex-1">{b.display_name || "?"}{b.me ? ` (${t("you")})` : ""}</span>
                  <span className={`font-[family-name:var(--font-display)] font-bold ltr-island ${b.balance_minor > 0 ? "text-olive" : b.balance_minor < 0 ? "text-bougain" : "text-ink-soft"}`}>{m(b.balance_minor)}</span>
                </li>
              ))}
            </ul>
            <h3 className="font-semibold">{t("suggested")}</h3>
            {bal.data.suggested.length === 0 ? <p className="text-ink-soft">{t("allSettled")}</p> : (
              <ul className="flex flex-col gap-2">
                {bal.data.suggested.map((s, i) => (
                  <li key={i} className="flex flex-wrap items-center gap-3">
                    <span>{t("pays", { from: s.from.display_name || "?", to: s.to.display_name || "?", amount: m(s.amount_minor) })}</span>
                    {(s.from.user_id === me.user_id || s.to.user_id === me.user_id) && (
                      <ActionButton path={`/v1/households/${id}/settlements`} body={{ from_user: s.from.user_id, to_user: s.to.user_id, amount_minor: s.amount_minor }}
                        done={t("settled")}>{t("recordSettlement")}</ActionButton>
                    )}
                  </li>
                ))}
              </ul>
            )}
            <p className="text-sm text-ink-soft">{t("recordOnly")}</p>
          </section>
          <section aria-labelledby="add-title" className={box}>
            <h2 id="add-title" className="section-title">{t("addExpense")}</h2>
            <ExpenseForm householdId={id} me={me.user_id} exponent={H.exponent} currency={H.currency}
              mates={H.members.filter((x) => x.role === "flatmate").map((x) => ({ user_id: x.user_id, display_name: x.display_name }))} />
          </section>
          <section aria-labelledby="exp-title" className="flex flex-col gap-3">
            <h2 id="exp-title" className="section-title">{t("expenses")}</h2>
            {ex.data.items.length === 0 ? <p className="text-ink-soft">{t("noExpense")}</p> : (
              <ul className="divide-y divide-line border-y border-line">
                {ex.data.items.map((x) => (
                  <li key={x.expense_id} className="flex flex-col gap-1 py-3">
                    <p className="flex flex-wrap justify-between gap-2"><span className="font-semibold [overflow-wrap:anywhere]">{x.label}</span>
                      <span className="ltr-island">{m(x.amount.amount_minor)}</span></p>
                    <p className="text-sm text-ink-soft">{t(`categories.${x.category}`)} · {fmt.dateTime(new Date(x.spent_on + "T00:00:00Z"), { dateStyle: "medium", timeZone: "UTC" })} · {t("paidByName", { name: x.paid_by.display_name || "?" })}</p>
                    <p className="text-sm">{x.shares.map((s) => `${s.display_name || "?"} ${m(s.share_minor)}`).join(" · ")}</p>
                    {x.can_delete && <ActionButton method="DELETE" path={`/v1/households/${id}/expenses/${x.expense_id}`} variant="quiet">{t("delete")}</ActionButton>}
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      )}
    </div>
  );
}
