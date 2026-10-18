// /households/[id]/shopping (platform P6): the shared shopping list (flatmates only).
import { getTranslations, setRequestLocale } from "next-intl/server";
import { Link } from "@/i18n/navigation";
import { Field, Input, Notice } from "@/components/ui/field";
import { ActionButton } from "@/components/home/action-button";
import { FormAction } from "@/components/home/form-action";
import { HouseholdNav } from "@/components/home/household-nav";
import { requireMember } from "@/lib/server/guard";
import { loadHousehold } from "@/lib/home-page";

interface List { items: Array<{ item_id: string; label: string; quantity: string | null; done: boolean; added_by: { display_name: string | null } | null }> }

export default async function Shopping({ params }: { params: Promise<{ locale: string; id: string }> }) {
  const { locale, id } = await params;
  setRequestLocale(locale);
  const me = await requireMember(locale);
  const t = await getTranslations("home");
  const e = await getTranslations("errors");
  const { h, d } = await loadHousehold<List>(me.user_id, id, "/shopping");
  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-6">
      <Link href={`/households/${id}`} className="link-back">{h.name}</Link>
      <h1 className="page-title">{t("nav.shopping")}</h1>
      <HouseholdNav id={id} role={h.my_role} current="shopping" />
      <FormAction path={`/v1/households/${id}/shopping`} kind="shopping" submit={t("add")}>
        <div className="grid grid-cols-[1fr_7rem] gap-3">
          <Field id="label" label={t("item")}><Input id="label" name="label" required maxLength={80} /></Field>
          <Field id="quantity" label={t("quantity")}><Input id="quantity" name="quantity" maxLength={30} /></Field>
        </div>
      </FormAction>
      {!d || !d.ok ? <Notice tone="error">{e(d && !d.ok ? d.error.code : "INTERNAL")}</Notice> : (
        <ul className="divide-y divide-line border-y border-line">
          {d.data.items.map((s) => (
            <li key={s.item_id} className="flex flex-wrap items-center justify-between gap-2 py-2">
              <span className={s.done ? "text-ink-soft line-through" : ""}>{s.label}{s.quantity ? ` · ${s.quantity}` : ""}</span>
              <ActionButton method="PATCH" path={`/v1/households/${id}/shopping/${s.item_id}`} body={{ done: !s.done }} variant="quiet">
                {s.done ? t("undo") : t("bought")}
              </ActionButton>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
