import { getTranslations, setRequestLocale } from "next-intl/server";
import { AuthFrame } from "@/components/auth-frame";
import { ResendForm } from "@/components/forms/auth-forms";

export async function generateMetadata() {
  const t = await getTranslations("auth.verify");
  return { title: t("title") };
}

export default async function Verify({ params, searchParams }:
  { params: Promise<{ locale: string }>; searchParams: Promise<{ email?: string; error?: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const { email = "" } = await searchParams;
  const t = await getTranslations("auth.verify");
  const clean = /^[^\s@]{1,64}@[^\s@]{1,190}$/.test(email) ? email : "";
  return (
    <AuthFrame title={t("title")} lead={clean ? t("body", { email: `\u2068${clean}\u2069` }) : t("bodyNoEmail")}>
      <ResendForm locale={locale} email={clean} />
    </AuthFrame>
  );
}
