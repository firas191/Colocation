import { getTranslations, setRequestLocale } from "next-intl/server";
import { AuthFrame } from "@/components/auth-frame";
import { ResetRequestForm } from "@/components/forms/auth-forms";

export async function generateMetadata() {
  const t = await getTranslations("auth.reset");
  return { title: t("title") };
}

export default async function Reset({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations("auth.reset");
  return <AuthFrame title={t("title")} lead={t("lead")}><ResetRequestForm locale={locale} /></AuthFrame>;
}
