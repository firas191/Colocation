"use client";
// Publish (platform P3): the API checks what is missing and publishes; this only shows its answer (422: what to add,
// 409: an analysis is running). From P8 the trust check runs first (D-107), and from P12 it runs as a job
// (POST /v2/listings/{id}/submit, D-112): the panel says the listing is being checked and asks every 3 s how the
// check ended: published, in review with a moderator, or refused, with the signal codes.
import { useEffect, useState, useTransition } from "react";
import { useLocale, useTranslations } from "next-intl";
import { Link, useRouter } from "@/i18n/navigation";
import { Button } from "@/components/ui/button";
import { Notice } from "@/components/ui/field";
import { submitListingAction, trustCheckAction } from "@/lib/actions/owner";
import type { Detail } from "@/lib/errors";

type Res = { ok: boolean; error?: string; details?: Detail[] };

export function PublishPanel({ listingId, canSubmit, running }: { listingId: string; canSubmit: boolean; running: boolean }) {
  const t = useTranslations("owner");
  const e = useTranslations("errors");
  const locale = useLocale();
  const router = useRouter();
  const [pending, start] = useTransition();
  const [res, setRes] = useState<null | Res>(null);
  const [job, setJob] = useState<string | null>(null);

  useEffect(() => {
    if (!job) return;
    let stop = false;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      const s = await trustCheckAction(job).catch(() => ({ done: false as const }));
      if (stop) return;
      if (!s.done) { timer = setTimeout(tick, 3000); return; }
      setJob(null);
      if (s.outcome === "published") setRes({ ok: true });
      else if (s.outcome === "in_review" || s.outcome === "rejected") {
        setRes({ ok: false, error: "CONFLICT", details: [{ field: "trust", issue: s.outcome, signals: s.signals } as Detail] });
      } else if (s.outcome === "not_submitted") setRes({ ok: false, error: "CONFLICT", details: s.details || [] });
      else setRes({ ok: false, error: "TRUST_CHECK_FAILED" });
      router.refresh();
    };
    timer = setTimeout(tick, 1500);
    return () => { stop = true; clearTimeout(timer); };
  }, [job, router]);

  const publish = () => start(async () => {
    setRes(null);
    const r = await submitListingAction(locale, listingId, `submit-${crypto.randomUUID()}`);
    if (r.ok && r.jobId) { setJob(r.jobId); return; }
    setRes(r);
    router.refresh();
  });
  if (res?.ok) {
    return (
      <div className="flex flex-col gap-3">
        <Notice tone="ok">{t("publishedDone")}</Notice>
        <div className="flex flex-wrap gap-4">
          <Link href={`/listings/${listingId}`} className="link-action">{t("seeIt")}</Link>
          <Link href="/owner/listings" className="link-back">{t("back")}</Link>
        </div>
      </div>
    );
  }
  const missing = (res?.details || []).filter((d) => d.field && ["rent", "place", "photos"].includes(d.field));
  const trust = (res?.details || []).find((d) => d.field === "trust") as (Detail & { signals?: string[] }) | undefined;
  return (
    <div className="flex flex-col gap-3">
      <Button type="button" onClick={publish} disabled={pending || !!job || !canSubmit} className="self-start">
        {pending || job ? t("publishing") : t("publish")}
      </Button>
      {job && <p role="status" className="text-sm text-ink-soft">{t("trustChecking")}</p>}
      {running && <p className="text-sm text-ink-soft">{t("waitAnalysis")}</p>}
      {res && !res.ok && (
        missing.length > 0
          ? <Notice tone="error">{t("missingTitle")} {missing.map((d) => t(`missing.${d.field}`)).join(", ")}</Notice>
          : trust && (trust.issue === "in_review" || trust.issue === "rejected")
            ? (
              <Notice tone={trust.issue === "rejected" ? "error" : "info"}>
                {t(trust.issue === "rejected" ? "trustRejected" : "trustReview")}
                {(trust.signals || []).length > 0 && <> {t("trustBecause")} {(trust.signals || [])
                  .map((s) => (t.has(`signals.${s}`) ? t(`signals.${s}`) : s)).join(", ")}.</>}
              </Notice>
            )
          : res.error === "TRUST_CHECK_FAILED"
            ? <Notice tone="error">{t("trustCheckFailed")}</Notice>
          : res.error === "CONFLICT" && (res.details || []).some((d) => d.field === "analysis")
            ? <Notice>{t("waitAnalysis")}</Notice>
            : <Notice tone="error">{res.error && e.has(res.error) ? e(res.error) : e("INTERNAL")}</Notice>
      )}
    </div>
  );
}
