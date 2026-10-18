// /owner/listings/[id] (platform P3): one listing of the owner, step by step. Photos and analysis (presigned upload,
// analysis job), what was understood (corrections with PATCH), publication (POST .../submit); once published,
// corrections, archive and publish again. Data: GET /v1/me/listings?listing_id (what is missing, the actions that
// apply), GET /v1/listings/{id}/public (fields and signed photo URLs), GET /v1/listings/{id} (refused uploads).
import { notFound } from "next/navigation";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { Link } from "@/i18n/navigation";
import { Notice } from "@/components/ui/field";
import { Photo } from "@/components/listing/photo";
import { PhotoStep } from "@/components/owner/photo-step";
import { PublishPanel } from "@/components/owner/publish-panel";
import { ReviewForm, type ReviewValues } from "@/components/owner/review-form";
import { StatusButton } from "@/components/owner/status-button";
import { SlotEditor } from "@/components/contact/slot-editor";
import { Steps, type Step } from "@/components/owner/steps";
import { requireMember } from "@/lib/server/guard";
import { api } from "@/lib/server/api";
import { clientIp } from "@/lib/server/viewer";
import type { PhotoUrl, PublicListing } from "@/lib/listing";
import type { MyListings } from "@/lib/owner";

export async function generateMetadata() {
  const t = await getTranslations("owner");
  return { title: t("wizardTitle") };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Main units for the form, from minor units and the currency's exponent (display only; the API converts back). */
const main = (minor: number | null | undefined, exp: number) => (minor === null || minor === undefined ? "" : String(minor / 10 ** exp));
const tri = (v: boolean | null | undefined) => (v === true ? "true" : v === false ? "false" : "");

export default async function OwnerListing({ params }: { params: Promise<{ locale: string; id: string }> }) {
  const { locale, id } = await params;
  setRequestLocale(locale);
  const me = await requireMember(locale);
  if (!UUID.test(id)) notFound();
  const t = await getTranslations("owner");
  const l = await getTranslations("listing");
  const e = await getTranslations("errors");
  const c = await getTranslations("card");
  const sr = await getTranslations("search");
  const o = { userId: me.user_id, clientIp: await clientIp(), lang: locale };
  const [mine, pub, view, slots] = await Promise.all([
    api<MyListings>("GET", "/v1/me/listings", { ...o, query: { listing_id: id } }),
    api<{ listing: PublicListing; photos: Array<PhotoUrl & { media_id: string }>; warnings: string[] }>("GET", `/v1/listings/${id}/public`, o),
    api<{ uploads: Array<{ status: string; error_code: string | null }> }>("GET", `/v1/listings/${id}`, o),
    api<{ items: Array<{ starts_at: string; ends_at: string; capacity: number }> }>("GET", `/v1/listings/${id}/visit-slots`, o),
  ]);
  const ct = await getTranslations("contact");
  if (!mine.ok || !pub.ok) {
    if ((mine.ok && mine.data.items.length === 0) || (!pub.ok && pub.status === 404)) notFound();
    const code = !mine.ok ? mine.error.code : !pub.ok ? pub.error.code : "INTERNAL";
    return <div className="mx-auto max-w-3xl"><Notice tone="error">{e.has(code) ? e(code) : e("INTERNAL")}</Notice></div>;
  }
  const x = mine.data.items[0];
  if (!x) notFound();
  const L = pub.data.listing;
  const photos = pub.data.photos;
  const draft = x.status === "draft";
  const running = !!x.analysis && ["queued", "running"].includes(x.analysis.status);
  const analysed = !!x.analysis;
  const step: Step = !analysed ? "photos" : x.readiness?.ready ? "publish" : "check";
  const jur = me.jurisdictions.find((j) => j.code === x.jurisdiction_code);
  const currency = L.rent?.currency || jur?.currency || "TND";
  const exp = L.rent?.exponent ?? jur?.exponent ?? 2;
  const values: ReviewValues = {
    rent: main(L.rent?.amount_minor, exp), rent_period: L.rent?.period || "month", deposit: main(L.deposit_minor, exp),
    bills_included: tri(L.bills_included), furnished: tri(L.furnished), available_from: L.available_from || "",
    bedrooms: L.bedrooms === null || L.bedrooms === undefined ? "" : String(L.bedrooms),
    min_stay_months: L.min_stay_months === null || L.min_stay_months === undefined ? "" : String(L.min_stay_months),
    place: L.neighbourhood || L.city || "", amenities: L.amenities || [], rules: (L.house_rules || {}) as Record<string, string>,
  };
  const refused = (view.ok ? view.data.uploads : []).filter((u) => u.status === "rejected");
  const reasons = [...new Set(refused.map((u) => u.error_code || "other"))]
    .map((c) => (t.has(`rejectReasons.${c}`) ? t(`rejectReasons.${c}`) : t("rejectReasons.other")));
  const title = x.display_title || c("untitled");
  const status = l.has(`statuses.${x.status}`) ? l(`statuses.${x.status}`) : x.status;
  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-8">
      <Link href="/owner/listings" className="link-back">{t("back")}</Link>
      <header className="flex flex-col gap-2">
        <p className="text-sm font-semibold text-ink-soft">
          {t("status", { status })}{x.number ? ` · ${t("number", { n: x.number })}` : ""}
        </p>
        <h1 className="page-title">{title}</h1>
      </header>
      {draft && <Steps current={step} />}
      {pub.data.warnings.includes("photos_unavailable") && <Notice>{sr("warnings.photos_unavailable")}</Notice>}

      <section aria-labelledby="photos-title" className="panel flex flex-col gap-4 p-5 sm:p-6">
        <h2 id="photos-title" className="section-title">{t("photosTitle")}</h2>
        {x.actions.analyze && <p className="max-w-prose text-ink-soft">{t("photosLead")}</p>}
        {photos.length === 0 ? <p className="text-ink-soft">{t("noPhotoYet")}</p> : (
          <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            {photos.map((p, i) => (
              <li key={p.media_id}>
                <Photo src={p.url} alt={t("photoAlt", { n: i + 1 })} className="aspect-[4/3] w-full rounded-panel object-cover"
                  fallback={c("noPhoto")} loading="lazy" />
              </li>
            ))}
          </ul>
        )}
        {refused.length > 0 && <Notice tone="error">{t("rejected", { count: refused.length, reasons: reasons.join(", ") })}</Notice>}
        {x.analysis?.status === "failed" && !running && <Notice tone="error">{t("analyzeFailed")}</Notice>}
        {x.actions.analyze && (
          <PhotoStep listingId={x.listing_id} runningJob={running ? x.analysis!.job_id : null} canAnalyze={x.actions.analyze} analysed={analysed} />
        )}
      </section>

      {x.actions.edit && (
        <section aria-labelledby="check-title" className="panel flex flex-col gap-4 p-5 sm:p-6">
          <h2 id="check-title" className="section-title">{t("checkTitle")}</h2>
          <p className="max-w-prose text-ink-soft">{analysed || !draft ? t("checkLead") : t("notAnalyzed")}</p>
          {draft && x.readiness && x.readiness.issues.length > 0 && (
            <div className="rounded-field border-s-4 border-saffron bg-saffron/10 px-4 py-3">
              <h3 className="font-semibold">{t("issuesTitle")}</h3>
              <ul className="mt-1 list-disc ps-5 text-[0.95rem]">
                {x.readiness.issues.map((i) => <li key={i}>{t.has(`issues.${i}`) ? t(`issues.${i}`) : t("issues.other", { code: i })}</li>)}
              </ul>
            </div>
          )}
          <ReviewForm listingId={x.listing_id} values={values} currency={currency} />
        </section>
      )}

      {draft && (
        <section aria-labelledby="publish-title" className="panel flex flex-col gap-4 p-5 sm:p-6">
          <h2 id="publish-title" className="section-title">{t("publishTitle")}</h2>
          <p className="max-w-prose text-ink-soft">{t("publishLead")}</p>
          {x.readiness && x.readiness.missing.length > 0 && (
            <div>
              <p className="font-semibold">{t("missingTitle")}</p>
              <ul className="mt-1 list-disc ps-5">{x.readiness.missing.map((m) => <li key={m.field}>{t(`missing.${m.field}`)}</li>)}</ul>
            </div>
          )}
          <PublishPanel listingId={x.listing_id} canSubmit={x.actions.submit} running={running} />
        </section>
      )}

      {x.status === "published" && (
        <section aria-labelledby="slots-title" className="flex flex-col gap-3">
          <h2 id="slots-title" className="text-xl font-semibold">{ct("slotsTitle")}</h2>
          <p className="max-w-prose text-ink-soft">{ct("slotsLead")}</p>
          <SlotEditor listingId={x.listing_id} slots={slots.ok ? slots.data.items : []} />
        </section>
      )}

      {!draft && (
        <section aria-labelledby="state-title" className="flex flex-col gap-3">
          <h2 id="state-title" className="text-xl font-semibold">{t("status", { status })}</h2>
          {x.status === "published" && <p>{t("publishedNote")}</p>}
          {/* after the trust check (D-107, D-112): what happens next, rather than only the status */}
          {x.status === "pending_review" && <p>{t("trustReview")}</p>}
          {x.status === "rejected" && <p>{t("trustRejected")}</p>}
          {!["published", "archived", "pending_review", "rejected"].includes(x.status) && <p>{t("notADraft", { status })}</p>}
          <div className="flex flex-wrap items-start gap-4">
            {x.actions.view && <Link href={`/listings/${x.listing_id}`} className="link-action">{t("seeIt")}</Link>}
            {x.actions.view && <Link href={`/search?country=${x.jurisdiction_code}`} className="link-action">{t("findIt")}</Link>}
            {x.actions.archive && <StatusButton listingId={x.listing_id} to="archived" title={title} />}
            {x.actions.republish && <StatusButton listingId={x.listing_id} to="published" title={title} />}
          </div>
          {x.actions.archive && <p className="text-sm text-ink-soft">{t("archiveHint")}</p>}
        </section>
      )}
    </div>
  );
}
