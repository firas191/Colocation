import { getTranslations, setRequestLocale } from "next-intl/server";
import { AuthFrame } from "@/components/auth-frame";
import { SignUpForm } from "@/components/forms/auth-forms";
import { redirect } from "@/i18n/navigation";
import { getViewer } from "@/lib/server/viewer";

export async function generateMetadata() {
  const t = await getTranslations("auth.signup");
  return { title: t("title") };
}

export default async function SignUp({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  if (await getViewer()) redirect({ href: "/profile", locale });
  const t = await getTranslations("auth.signup");
  return <AuthFrame title={t("title")} lead={t("lead")}><SignUpForm locale={locale} /></AuthFrame>;
}
