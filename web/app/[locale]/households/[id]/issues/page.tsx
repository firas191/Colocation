// /households/[id]/issues (platform P6): repairs sent to the owner member, with photos (blurred, no EXIF) and updates.
import { getFormatter, getTranslations, setRequestLocale } from "next-intl/server";
import { Link } from "@/i18n/navigation";
import { Field, Input, Notice, Select, Textarea } from "@/components/ui/field";
import { Photo } from "@/components/listing/photo";
import { FormAction } from "@/components/home/form-action";
import { HouseholdNav } from "@/components/home/household-nav";
import { IssuePhotos } from "@/components/home/issue-photos";
import { requireMember } from "@/lib/server/guard";
import { loadHousehold } from "@/lib/home-page";

interface Issues { my_role: string; items: Array<{ issue_id: string; title: string; description: string | null; category: string; urgency: string;
  status: string; reported_by: { display_name: string | null } | null; created_at: string; photos: Array<{ url: string }>;
  events: Array<{ status: string | null; comment: string | null; at: string; by: { display_name: string | null } | null }> }> }

export default async function IssuesPage({ params }: { params: Promise<{ locale: string; id: string }> }) {
  const { locale, id } = await params;
  setRequestLocale(locale);
  const me = await requireMember(locale);
  const t = await getTranslations("home");
  const e = await getTranslations("errors");
  const fmt = await getFormatter();
  const { h, d } = await loadHousehold<Issues>(me.user_id, id, "/issues");
  const statuses = h.my_role === "owner" ? ["acknowledged", "in_progress", "resolved"] : ["closed", "open"];
  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-6">
      <Link href={`/households/${id}`} className="link-back">{h.name}</Link>
      <h1 className="page-title">{t("nav.issues")}</h1>
      <HouseholdNav id={id} role={h.my_role} current="issues" />
      <section aria-labelledby="new-issue" className="flex flex-col gap-3 panel p-4">
        <h2 id="new-issue" className="section-title">{t("newIssue")}</h2>
        <FormAction path={`/v1/households/${id}/issues`} kind="issue" submit={t("send")}>
          <Field id="is-title" label={t("issueTitle")}><Input id="is-title" name="title" required maxLength={120} /></Field>
          <Field id="is-desc" label={t("description")}><Textarea id="is-desc" name="description" maxLength={2000} rows={3} /></Field>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field id="is-cat" label={t("category")}><Select id="is-cat" name="category" defaultValue="other">
              {["plumbing", "electricity", "heating", "appliance", "internet", "pests", "structure", "other"].map((c) => <option key={c} value={c}>{t(`issueCats.${c}`)}</option>)}</Select></Field>
            <Field id="is-urg" label={t("urgency")}><Select id="is-urg" name="urgency" defaultValue="normal">
              {["low", "normal", "urgent"].map((c) => <option key={c} value={c}>{t(`urgencies.${c}`)}</option>)}</Select></Field>
          </div>
        </FormAction>
      </section>
      {!d || !d.ok ? <Notice tone="error">{e(d && !d.ok ? d.error.code : "INTERNAL")}</Notice> : (
        <ul className="flex flex-col gap-4">
          {d.data.items.map((i) => (
            <li key={i.issue_id} className="flex flex-col gap-2 panel p-4">
              <p className="text-sm font-semibold text-ink-soft">{t(`issueStatus.${i.status}`)} · {t(`urgencies.${i.urgency}`)} · {t(`issueCats.${i.category}`)}</p>
              <h2 className="text-lg font-semibold [overflow-wrap:anywhere]">{i.title}</h2>
              {i.description && <p className="whitespace-pre-line [overflow-wrap:anywhere]">{i.description}</p>}
              {i.photos.length > 0 && (
                <ul className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                  {i.photos.map((p, n) => <li key={n}><Photo src={p.url} alt={t("issuePhoto", { n: n + 1 })} className="aspect-[4/3] w-full rounded-field object-cover" fallback="—" loading="lazy" /></li>)}
                </ul>
              )}
              <ol className="flex flex-col gap-1 text-sm">
                {i.events.map((ev, n) => <li key={n}>{fmt.dateTime(new Date(ev.at), { dateStyle: "short", timeStyle: "short" })} · {ev.by?.display_name || "?"}{ev.status ? ` · ${t(`issueStatus.${ev.status}`)}` : ""}{ev.comment ? ` · ${ev.comment}` : ""}</li>)}
              </ol>
              <IssuePhotos issueId={i.issue_id} />
              <FormAction path={`/v1/issues/${i.issue_id}/updates`} kind="issueUpdate" submit={t("update")}>
                <div className="grid gap-3 sm:grid-cols-[12rem_1fr]">
                  <Field id={`st-${i.issue_id}`} label={t("status")}><Select id={`st-${i.issue_id}`} name="status" defaultValue="">
                    <option value="">—</option>{statuses.map((s) => <option key={s} value={s}>{t(`issueStatus.${s}`)}</option>)}</Select></Field>
                  <Field id={`cm-${i.issue_id}`} label={t("comment")}><Input id={`cm-${i.issue_id}`} name="comment" maxLength={1000} /></Field>
                </div>
              </FormAction>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
