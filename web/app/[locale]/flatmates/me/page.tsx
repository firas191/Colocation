// /flatmates/me (platform P7): the caller's flatmate profile. Compatibility uses the lifestyle answers of the search
// profile (/profile), never the text written here (PLATFORM_SPEC rule 2.6).
import { getTranslations, setRequestLocale } from "next-intl/server";
import { Link } from "@/i18n/navigation";
import { Check, Field, Input, Notice, Select, Textarea } from "@/components/ui/field";
import { FormAction } from "@/components/home/form-action";
import { ProfileAssistant } from "@/components/flatmates/profile-assistant";
import { requireMember } from "@/lib/server/guard";
import { api } from "@/lib/server/api";
import { clientIp } from "@/lib/server/viewer";
import type { FlatmateProfile } from "@/lib/flatmates";

export async function generateMetadata() {
  return { title: (await getTranslations("flatmates"))("myProfile") };
}

export default async function MyFlatmateProfile({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const me = await requireMember(locale);
  const t = await getTranslations("flatmates");
  const e = await getTranslations("errors");
  const r = await api<{ profile: FlatmateProfile | null; has_lifestyle: boolean }>("GET", "/v1/me/flatmate-profile",
    { userId: me.user_id, clientIp: await clientIp() });
  if (!r.ok) return <Notice tone="error">{e.has(r.error.code) ? e(r.error.code) : e("INTERNAL")}</Notice>;
  const p = r.data.profile;
  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6">
      <Link href="/flatmates" className="link-back">{t("back")}</Link>
      <h1 className="page-title">{t("myProfile")}</h1>
      {!r.data.has_lifestyle && <Notice>{t("noLifestyle")} <Link href="/profile" className="link-action">{t("toProfile")}</Link></Notice>}
      <section aria-labelledby="fm-ai-title" className="flex flex-col gap-2 panel p-4">
        <h2 id="fm-ai-title" className="section-title">{t("assistantTitle")}</h2>
        <ProfileAssistant currency={me.jurisdictions.find((j) => j.code === me.jurisdiction_code)?.currency ?? null} />
      </section>
      <FormAction method="PUT" path="/v1/me/flatmate-profile" kind="flatmateProfile" submit={t("save")} done={t("saved")} resetOnDone={false}>
        <Check id="fp-visible" name="visible" label={t("visible")} defaultChecked={p?.visible ?? false} />
        <Field id="fp-headline" label={t("headline")}><Input id="fp-headline" name="headline" maxLength={80} defaultValue={p?.headline ?? ""} /></Field>
        <Field id="fp-bio" label={t("bio")} hint={t("bioHint")}><Textarea id="fp-bio" name="bio" maxLength={600} rows={4} defaultValue={p?.bio ?? ""} /></Field>
        <Field id="fp-seeking" label={t("seekingLabel")}>
          <Select id="fp-seeking" name="seeking" defaultValue={p?.seeking ?? "both"}>
            {(["room", "flatmate", "both"] as const).map((v) => <option key={v} value={v}>{t(`seeking.${v}`)}</option>)}
          </Select>
        </Field>
        <Field id="fp-areas" label={t("areas")} hint={t("areasHint")}><Input id="fp-areas" name="areas" maxLength={300} defaultValue={(p?.areas ?? []).join(", ")} /></Field>
        <Field id="fp-move" label={t("moveInLabel")}><Input id="fp-move" name="move_in_from" type="date" defaultValue={p?.move_in_from ?? ""} /></Field>
      </FormAction>
    </div>
  );
}
