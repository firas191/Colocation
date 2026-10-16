import { getTranslations, setRequestLocale } from "next-intl/server";
import { AuthFrame } from "@/components/auth-frame";
import { ResetForm } from "@/components/forms/auth-forms";
import { Notice } from "@/components/ui/field";
import { Link } from "@/i18n/navigation";

export async function generateMetadata() {
  const t = await getTranslations("auth.reset");
  return { title: t("newTitle") };
}

export default async function ResetNew({ params, searchParams }:
  { params: Promise<{ locale: string }>; searchParams: Promise<{ token?: string; error?: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const { token = "", error } = await searchParams;
  const t = await getTranslations("auth.reset");
  const valid = !error && /^[A-Za-z0-9_-]{8,256}$/.test(token);
  return (
    <AuthFrame title={t("newTitle")}>
      {valid ? <ResetForm locale={locale} token={token} /> : <Notice tone="error">{t("invalidToken")} <Link href="/reset">{t("submit")}</Link></Notice>}
    </AuthFrame>
  );
}
