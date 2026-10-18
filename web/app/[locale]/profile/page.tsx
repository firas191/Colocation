import { getTranslations, setRequestLocale } from "next-intl/server";
import { ProfileForm, type Profile } from "@/components/forms/profile-form";
import { Notice } from "@/components/ui/field";
import { requireMember } from "@/lib/server/guard";
import { api } from "@/lib/server/api";
import { clientIp } from "@/lib/server/viewer";

export async function generateMetadata() {
  const t = await getTranslations("profile");
  return { title: t("title") };
}

export default async function ProfilePage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const me = await requireMember(locale);
  const t = await getTranslations("profile");
  const e = await getTranslations("errors");
  const r = await api<{ profile: Profile | null }>("GET", "/v1/profiles/me", { userId: me.user_id, clientIp: await clientIp(), lang: locale });
  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-8">
      <div className="flex flex-col gap-3">
        <h1 className="page-title">{t("title")}</h1>
        <p className="max-w-prose text-ink-soft">{t("lead")}</p>
      </div>
      {r.ok ? (
        <ProfileForm locale={locale} profile={r.data.profile} jurisdictions={me.jurisdictions}
          defaultJurisdiction={me.jurisdiction_code || me.jurisdictions.find((j) => j.code === "TN")?.code || me.jurisdictions[0]?.code || ""} />
      ) : <Notice tone="error">{e.has(r.error.code) ? e(r.error.code) : e("INTERNAL")}</Notice>}
    </div>
  );
}
