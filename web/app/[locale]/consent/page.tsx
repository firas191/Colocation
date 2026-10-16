import { randomUUID } from "node:crypto";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { AuthFrame } from "@/components/auth-frame";
import { ConsentForm } from "@/components/forms/consent-form";
import { Notice } from "@/components/ui/field";
import { requireSignedIn } from "@/lib/server/guard";
import { getMe } from "@/lib/server/viewer";

export async function generateMetadata() {
  const t = await getTranslations("consent");
  return { title: t("title") };
}

export default async function Consent({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  await requireSignedIn(locale);
  const t = await getTranslations("consent");
  const e = await getTranslations("errors");
  const me = await getMe();
  if (!me || !me.ok) return <Notice tone="error">{e("UPSTREAM_UNAVAILABLE")}</Notice>;
  return (
    <AuthFrame title={t("title")} lead={t("lead")}>
      <ConsentForm locale={locale} idem={`consent-${randomUUID()}`} media={me.data.consents.media_processing?.granted === true} />
    </AuthFrame>
  );
}
