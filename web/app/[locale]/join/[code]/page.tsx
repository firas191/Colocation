// /join/[code] (platform P5): a link with an invite code; the member confirms with one button.
import { getTranslations, setRequestLocale } from "next-intl/server";
import { ActionButton } from "@/components/home/action-button";
import { requireMember } from "@/lib/server/guard";

export default async function Join({ params }: { params: Promise<{ locale: string; code: string }> }) {
  const { locale, code } = await params;
  setRequestLocale(locale);
  await requireMember(locale);
  const t = await getTranslations("home");
  const c = decodeURIComponent(code).toUpperCase().slice(0, 14);
  return (
    <div className="mx-auto flex max-w-xl flex-col gap-4">
      <h1 className="page-title">{t("joinTitle")}</h1>
      <p>{t("joinWith")} <span className="font-semibold ltr-island">{c}</span></p>
      <ActionButton path="/v1/household-invites/accept" body={{ code: c }} variant="primary" then="/households">{t("join")}</ActionButton>
    </div>
  );
}
