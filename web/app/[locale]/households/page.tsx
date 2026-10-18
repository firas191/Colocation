// /households (platform P5): the caller's households, invites waiting for them, create one, join with a code.
import { getTranslations, setRequestLocale } from "next-intl/server";
import { Link } from "@/i18n/navigation";
import { Empty, Field, Input, Notice, Select } from "@/components/ui/field";
import { FormAction } from "@/components/home/form-action";
import { ActionButton } from "@/components/home/action-button";
import { currentCountry } from "@/lib/server/country";
import { requireMember } from "@/lib/server/guard";
import { api } from "@/lib/server/api";
import { clientIp } from "@/lib/server/viewer";

export async function generateMetadata() {
  return { title: (await getTranslations("home"))("title") };
}

interface Mine { items: Array<{ household_id: string; name: string; my_role: string; members: number }>;
  invites: Array<{ invite_id: string; role: string; household: { household_id: string; name: string } | null }> }

export default async function Households({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const me = await requireMember(locale);
  const t = await getTranslations("home");
  const e = await getTranslations("errors");
  const countries = await getTranslations("countries");
  const r = await api<Mine>("GET", "/v1/me/households", { userId: me.user_id, clientIp: await clientIp() });
  if (!r.ok) return <Notice tone="error">{e.has(r.error.code) ? e(r.error.code) : e("INTERNAL")}</Notice>;
  const box = "flex flex-col gap-3 panel p-4";
  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-8">
      <header className="flex flex-col gap-2">
        <h1 className="page-title">{t("title")}</h1>
        <p className="text-ink-soft">{t("lead")}</p>
      </header>
      {r.data.invites.length > 0 && (
        <section aria-labelledby="inv-title" className={box}>
          <h2 id="inv-title" className="section-title">{t("invitesTitle")}</h2>
          <ul className="flex flex-col gap-3">
            {r.data.invites.map((i) => (
              <li key={i.invite_id} className="flex flex-wrap items-center justify-between gap-3">
                <span>{i.household?.name}</span>
                <ActionButton path="/v1/household-invites/accept" body={{ invite_id: i.invite_id }} variant="primary"
                  then={i.household ? `/households/${i.household.household_id}` : undefined}>{t("acceptInvite")}</ActionButton>
              </li>
            ))}
          </ul>
        </section>
      )}
      {r.data.items.length === 0 ? <Empty>{t("none")}</Empty> : (
        <ul className="grid gap-4 sm:grid-cols-2">
          {r.data.items.map((h) => (
            <li key={h.household_id}>
              <Link href={`/households/${h.household_id}`} className="panel group flex items-center gap-4 p-5 text-ink no-underline transition-shadow hover:border-door hover:shadow-[var(--shadow-lift)]">
                <span aria-hidden="true" className="grid size-12 shrink-0 place-items-center rounded-panel bg-door-soft text-door">
                  <svg viewBox="0 0 24 24" className="size-6" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round"><path d="M4 10.5 12 4l8 6.5V20H4z" /><path d="M10 20v-5h4v5" /></svg>
                </span>
                <span className="flex flex-col gap-0.5">
                  <span className="font-[family-name:var(--font-display)] text-lg font-semibold group-hover:text-door">{h.name}</span>
                  <span className="text-sm text-ink-soft">{t(`roles.${h.my_role}`)} · {t("memberCount", { count: h.members })}</span>
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
      <div className="grid gap-5 md:grid-cols-2">
      <section aria-labelledby="join-title" className={box}>
        <h2 id="join-title" className="section-title">{t("joinTitle")}</h2>
        <FormAction path="/v1/household-invites/accept" kind="join" submit={t("join")}
          then="/households/{household_id}">
          <Field id="code" label={t("code")} hint={t("codeHint")}><Input id="code" name="code" required autoComplete="off" className="ltr-island uppercase" /></Field>
        </FormAction>
      </section>
      <section aria-labelledby="new-title" className={box}>
        <h2 id="new-title" className="section-title">{t("createTitle")}</h2>
        <FormAction path="/v1/households" kind="household" submit={t("create")}
          then="/households/{household_id}">
          <Field id="name" label={t("name")}><Input id="name" name="name" required maxLength={80} /></Field>
          <Field id="jurisdiction_code" label={t("country")}>
            <Select id="jurisdiction_code" name="jurisdiction_code" defaultValue={await currentCountry(me)}>
              {me.jurisdictions.map((j) => <option key={j.code} value={j.code}>{countries.has(j.code) ? countries(j.code) : j.name}</option>)}
            </Select>
          </Field>
          <Field id="role" label={t("myRole")}>
            <Select id="role" name="role" defaultValue="flatmate"><option value="flatmate">{t("roles.flatmate")}</option><option value="owner">{t("roles.owner")}</option></Select>
          </Field>
        </FormAction>
      </section>
      </div>
    </div>
  );
}
