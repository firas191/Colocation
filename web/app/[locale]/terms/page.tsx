import { getTranslations, setRequestLocale } from "next-intl/server";
import { Notice } from "@/components/ui/field";
import { POLICY_VERSION } from "@/lib/policy";

export async function generateMetadata() {
  const t = await getTranslations("legal");
  return { title: t("termsTitle") };
}

export default async function Page({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations("legal");
  const items = t.raw("terms") as string[];
  return (
    <article className="mx-auto flex max-w-2xl flex-col gap-6">
      <h1 className="page-title">{t("termsTitle")}</h1>
      <Notice>{t("draft")} <span className="ltr-island">({POLICY_VERSION})</span></Notice>
      <ul className="flex list-disc flex-col gap-3 ps-5 leading-relaxed">{items.map((x) => <li key={x}>{x}</li>)}</ul>
    </article>
  );
}
