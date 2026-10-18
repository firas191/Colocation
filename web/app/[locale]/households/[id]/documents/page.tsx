// /households/[id]/documents (platform P9, D-108): the documents the household's country offers, each with the
// primary sources its template was written from; forms for each type, the Document agent, and the documents made.
// The API fills household facts, checks every slot and renders the PDF; this page only collects the person's values.
import { notFound } from "next/navigation";
import { getFormatter, getTranslations, setRequestLocale } from "next-intl/server";
import { Link } from "@/i18n/navigation";
import { Field, Input, Notice, Select, Textarea } from "@/components/ui/field";
import { FormAction } from "@/components/home/form-action";
import { HouseholdNav } from "@/components/home/household-nav";
import { DocumentAssistant } from "@/components/home/document-assistant";
import { requireMember } from "@/lib/server/guard";
import { api } from "@/lib/server/api";
import { clientIp } from "@/lib/server/viewer";
import { money, type Household } from "@/lib/home";

interface Source { cite_as: string; title: string; url: string; retrieved_at: string; publisher: string }
interface Tpl { key: string; kind: string; version: number; legal: boolean; languages: string[]; sources: Source[] }
interface Doc { document_id: string; kind: string; language: string; status: string; created_at: string; created_by: { display_name: string | null } | null;
  template: { key: string; version: number } }
interface Pay { items: Array<{ payment_id: string; user: { display_name: string | null }; period: string; amount_minor: number; confirmed: boolean }> }

export default async function Documents({ params }: { params: Promise<{ locale: string; id: string }> }) {
  const { locale, id } = await params;
  setRequestLocale(locale);
  const me = await requireMember(locale);
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const t = await getTranslations("documents");
  const e = await getTranslations("errors");
  const fmt = await getFormatter();
  const o = { userId: me.user_id, clientIp: await clientIp() };
  const h = await api<Household>("GET", `/v1/households/${id}`, o);
  if (!h.ok) notFound();
  const H = h.data;
  const [tp, docs, pay] = await Promise.all([
    api<{ items: Tpl[]; not_available: string[] }>("GET", "/v1/document-templates", { ...o, query: { jurisdiction: H.jurisdiction_code } }),
    api<{ items: Doc[] }>("GET", `/v1/households/${id}/documents`, o),
    H.my_role === "owner" ? api<Pay>("GET", `/v1/households/${id}/rent-payments`, o) : Promise.resolve(null)]);
  const tpls = tp.ok ? tp.data.items : [];
  const has = (k: string) => tpls.find((x) => x.kind === k);
  const box = "flex flex-col gap-3 panel p-4";
  const langs = (k: string) => (has(k)?.languages || ["fr"]);
  const langField = (k: string, idp: string) => (
    <Field id={`${idp}-lang`} label={t("language")}>
      <Select id={`${idp}-lang`} name="language" defaultValue={langs(k).includes(locale) ? locale : langs(k)[0]}>
        {langs(k).map((l) => <option key={l} value={l}>{t(`langs.${l}`)}</option>)}
      </Select>
    </Field>
  );
  const sources = (k: string) => {
    const x = has(k);
    if (!x) return null;
    return x.sources.length === 0 ? <p className="text-sm text-ink-soft">{t("noLaw")}</p> : (
      <details className="text-sm"><summary className="cursor-pointer">{t("sources")}</summary>
        <ul className="mt-2 flex flex-col gap-1">
          {x.sources.map((s) => <li key={s.cite_as}>{s.cite_as} · <a href={s.url} rel="noreferrer" className="ltr-island">{s.url}</a> · {t("readOn", { date: s.retrieved_at })}<br />
            <span className="text-ink-soft">{s.publisher}</span></li>)}
        </ul>
      </details>
    );
  };
  const done = t("made");
  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-6">
      <Link href={`/households/${id}`} className="link-back">{H.name}</Link>
      <h1 className="page-title">{t("title")}</h1>
      <HouseholdNav id={id} role={H.my_role} current="documents" />
      <Notice>{t("notice")}</Notice>
      {!tp.ok && <Notice tone="error">{e.has(tp.error.code) ? e(tp.error.code) : e("INTERNAL")}</Notice>}
      {tp.ok && tp.data.not_available.length > 0 && (
        <p className="text-sm text-ink-soft">{t("notAvailable", { list: tp.data.not_available.map((k) => t(`kinds.${k}`)).join(", ") })}</p>)}

      <section aria-labelledby="made-title" className={box}>
        <h2 id="made-title" className="section-title">{t("made_list")}</h2>
        {!docs.ok ? <Notice tone="error">{e.has(docs.error.code) ? e(docs.error.code) : e("INTERNAL")}</Notice>
          : docs.data.items.length === 0 ? <p className="text-ink-soft">{t("none")}</p> : (
            <ul className="flex flex-col gap-2">
              {docs.data.items.map((d) => (
                <li key={d.document_id}>
                  {d.status === "ready"
                    ? <a href={`/${locale}/documents/${d.document_id}/download`}>{t(`kinds.${d.kind}`)}</a>
                    : <span>{t(`kinds.${d.kind}`)} ({t("failedDoc")})</span>}
                  {d.kind === "inventory_exit" && d.status === "ready" && <> · <Link href={`/households/${id}/documents/${d.document_id}`} className="link-action">{t("compare")}</Link></>}
                  {" "}· {t(`langs.${d.language}`)} · {fmt.dateTime(new Date(d.created_at), { dateStyle: "medium" })} · {d.created_by?.display_name || "—"}
                </li>
              ))}
            </ul>
          )}
      </section>

      {H.my_role !== "owner" && (
        <section aria-labelledby="ai-title" className={box}>
          <h2 id="ai-title" className="section-title">{t("assistant")}</h2>
          <DocumentAssistant householdId={id} />
        </section>
      )}

      {has("house_rules") && (
        <section aria-labelledby="rules-title" className={box}>
          <h2 id="rules-title" className="section-title">{t("kinds.house_rules")}</h2>
          <p className="text-sm text-ink-soft">{t("rulesLead")}</p>
          <FormAction path={`/v1/households/${id}/documents`} kind="docRules" submit={t("make")} done={done} resetOnDone={false}>
            {langField("house_rules", "rules")}
          </FormAction>
        </section>
      )}

      {has("living_plan") && H.my_role !== "owner" && (
        <section aria-labelledby="plan-title" className={box}>
          <h2 id="plan-title" className="section-title">{t("kinds.living_plan")}</h2>
          <p className="text-sm text-ink-soft">{t("livingLead")}</p>
          <FormAction path={`/v1/households/${id}/documents`} kind="docLivingPlan" submit={t("make")} done={done} resetOnDone={false}>
            {langField("living_plan", "plan")}
            <Field id="plan-start" label={t("slots.start_date")}><Input id="plan-start" name="start_date" type="date" /></Field>
            <Field id="plan-notes" label={t("slots.notes")}><Textarea id="plan-notes" name="notes" rows={3} maxLength={1000} /></Field>
          </FormAction>
        </section>
      )}

      {(["inventory_entry", "inventory_exit"] as const).filter((k) => has(k)).map((k) => (
        <section key={k} aria-labelledby={`${k}-title`} className={box}>
          <h2 id={`${k}-title`} className="section-title">{t(`kinds.${k}`)}</h2>
          {sources(k)}
          <FormAction path={`/v1/households/${id}/documents`} kind="docInventory" submit={t("make")} done={done}>
            <input type="hidden" name="kind" value={k} />
            {langField(k, k)}
            <Field id={`${k}-date`} label={t("slots.date")}><Input id={`${k}-date`} name="date" type="date" required /></Field>
            <Field id={`${k}-items`} label={t("slots.items")} hint={t("itemsHint")}>
              <Textarea id={`${k}-items`} name="items" rows={5} required placeholder={t("itemsPlaceholder")} />
            </Field>
          </FormAction>
        </section>
      ))}

      {has("flatmate_agreement") && H.my_role === "flatmate" && (
        <section aria-labelledby="agr-title" className={box}>
          <h2 id="agr-title" className="section-title">{t("kinds.flatmate_agreement")}</h2>
          {sources("flatmate_agreement")}
          <FormAction path={`/v1/households/${id}/documents`} kind="docAgreement" submit={t("make")} done={done}>
            {langField("flatmate_agreement", "agr")}
            <Field id="agr-start" label={t("slots.start_date")}><Input id="agr-start" name="start_date" type="date" required /></Field>
            <Field id="agr-notice" label={t("slots.notice_days")}><Input id="agr-notice" name="notice_days" type="number" min={0} max={365} required /></Field>
            <Field id="agr-shares" label={t("slots.shares")} hint={t("sharesHint")}><Textarea id="agr-shares" name="shares" rows={3} required /></Field>
          </FormAction>
        </section>
      )}

      {has("rent_receipt") && H.my_role === "owner" && pay && (
        <section aria-labelledby="rec-title" className={box}>
          <h2 id="rec-title" className="section-title">{t("kinds.rent_receipt")}</h2>
          {sources("rent_receipt")}
          {!pay.ok || pay.data.items.filter((p) => p.confirmed).length === 0 ? <p className="text-ink-soft">{t("noConfirmed")}</p> : (
            <FormAction path={`/v1/households/${id}/documents`} kind="docReceipt" submit={t("make")} done={done} resetOnDone={false}>
              {langField("rent_receipt", "rec")}
              <Field id="rec-pay" label={t("payment")}>
                <Select id="rec-pay" name="payment_id">
                  {pay.data.items.filter((p) => p.confirmed).map((p) => (
                    <option key={p.payment_id} value={p.payment_id}>{p.period} · {p.user.display_name || "—"} · {money(locale, p.amount_minor, H.currency, H.exponent)}</option>))}
                </Select>
              </Field>
            </FormAction>
          )}
        </section>
      )}
    </div>
  );
}
