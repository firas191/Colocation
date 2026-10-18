// /households/[id]/rules (platform P6): the house rules, written together (every member).
import { getTranslations, setRequestLocale } from "next-intl/server";
import { Link } from "@/i18n/navigation";
import { Notice } from "@/components/ui/field";
import { HouseholdNav } from "@/components/home/household-nav";
import { RulesEditor } from "@/components/home/rules-editor";
import { requireMember } from "@/lib/server/guard";
import { loadHousehold } from "@/lib/home-page";

export default async function Rules({ params }: { params: Promise<{ locale: string; id: string }> }) {
  const { locale, id } = await params;
  setRequestLocale(locale);
  const me = await requireMember(locale);
  const t = await getTranslations("home");
  const e = await getTranslations("errors");
  const { h, d } = await loadHousehold<{ items: Array<{ category: string; text: string }> }>(me.user_id, id, "/rules");
  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-6">
      <Link href={`/households/${id}`} className="link-back">{h.name}</Link>
      <h1 className="page-title">{t("nav.rules")}</h1>
      <HouseholdNav id={id} role={h.my_role} current="rules" />
      {!d || !d.ok ? <Notice tone="error">{e(d && !d.ok ? d.error.code : "INTERNAL")}</Notice> : <RulesEditor householdId={id} items={d.data.items} />}
    </div>
  );
}
