"use client";
// Photos and analysis (platform P3). The browser asks the website server for presigned URLs, sends each file straight
// to the storage proxy (the bytes never pass through the website), then starts the analysis job and follows it until
// it ends. The analysis itself (checks, blurring, extraction) is the backend's: wf.listing.analyze.
import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import { useLocale, useTranslations } from "next-intl";
import { useRouter } from "@/i18n/navigation";
import { Button } from "@/components/ui/button";
import { Notice } from "@/components/ui/field";
import { allowPhotosAction, analyzeAction, jobStatusAction, presignAction } from "@/lib/actions/owner";

type Msg = { tone: "info" | "ok" | "error"; text: string } | null;
const DONE = ["succeeded", "failed", "cancelled"];

export function PhotoStep({ listingId, runningJob, canAnalyze, analysed }:
  { listingId: string; runningJob: string | null; canAnalyze: boolean; analysed: boolean }) {
  const t = useTranslations("owner");
  const e = useTranslations("errors");
  const locale = useLocale();
  const router = useRouter();
  const input = useRef<HTMLInputElement>(null);
  const [files, setFiles] = useState<File[]>([]);
  const [msg, setMsg] = useState<Msg>(null);
  const [needConsent, setNeedConsent] = useState(false);
  const [job, setJob] = useState<string | null>(runningJob);
  const [busy, start] = useTransition();

  // Follows the analysis job every 3 s; reloads the page's data when it ends.
  useEffect(() => {
    if (!job) return;
    let stop = false;
    setMsg({ tone: "info", text: t("analyzing") });
    const tick = async () => {
      if (stop) return;
      const s = await jobStatusAction(job).catch(() => null);
      if (stop) return;
      if (s?.ok && s.status && DONE.includes(s.status)) {
        setJob(null);
        setMsg(s.status === "succeeded" ? { tone: "ok", text: t("analyzeDone") } : { tone: "error", text: t("analyzeFailed") });
        router.refresh();
        return;
      }
      setTimeout(tick, 3000);
    };
    const first = setTimeout(tick, 1500);
    return () => { stop = true; clearTimeout(first); };
  }, [job, router, t]);

  const analyze = useCallback(async () => {
    const r = await analyzeAction(listingId, `analyze-${crypto.randomUUID()}`);
    if (r.ok && r.jobId) setJob(r.jobId);
    else setMsg({ tone: "error", text: r.error && e.has(r.error) ? e(r.error) : t("analyzeFailed") });
  }, [listingId, e, t]);

  const send = () => start(async () => {
    if (files.length === 0) { await analyze(); return; }
    setMsg(null);
    const p = await presignAction(listingId, files.map((f) => ({ content_type: f.type || "application/octet-stream", bytes: f.size })),
      `presign-${crypto.randomUUID()}`);
    if (!p.ok || !p.uploads) {
      if (p.error === "CONSENT_REQUIRED" && p.purpose === "media_processing") { setNeedConsent(true); return; }
      // 422 details name each refused file: files[i].content_type not_accepted, files[i].bytes too_large, too_many
      const bad = (p.details || []).filter((d) => (d.field || "").startsWith("files["));
      const reasons = [...new Set(bad.map((d) => (d.issue === "too_large" ? "TOO_LARGE" : d.issue === "not_accepted" ? "UNSUPPORTED_TYPE" : "other")))];
      setMsg({ tone: "error", text: bad.length ? t("rejected", { count: bad.length, reasons: reasons.map((x) => t(`rejectReasons.${x}`)).join(", ") })
        : (p.error && e.has(p.error) ? e(p.error) : t("uploadFailed")) });
      return;
    }
    for (let i = 0; i < p.uploads.length; i++) {
      setMsg({ tone: "info", text: t("uploading", { n: i + 1, total: p.uploads.length }) });
      const u = p.uploads[i];
      const res = await fetch(u.url, { method: "PUT", headers: u.headers, body: files[i] }).catch(() => null);
      if (!res || !res.ok) { setMsg({ tone: "error", text: t("uploadFailed") }); return; }
    }
    setFiles([]);
    if (input.current) input.current.value = "";
    setMsg({ tone: "ok", text: t("uploaded", { count: p.uploads.length }) });
    await analyze();
  });

  const allow = () => start(async () => {
    const r = await allowPhotosAction(locale, `consent-media-${crypto.randomUUID()}`);
    if (r.ok) { setNeedConsent(false); send(); } else setMsg({ tone: "error", text: r.error && e.has(r.error) ? e(r.error) : e("INTERNAL") });
  });

  const running = !!job;
  return (
    <div className="flex flex-col gap-4">
      {canAnalyze && (
        <div className="flex flex-col gap-2">
          <label htmlFor="photos" className="text-sm font-semibold">{t("choose")}</label>
          <input ref={input} id="photos" name="photos" type="file" multiple accept="image/jpeg,image/png,image/webp"
            disabled={busy || running} aria-describedby="photos-hint"
            onChange={(ev) => setFiles(Array.from(ev.target.files || []).slice(0, 20))}
            className="block w-full max-w-full text-sm file:me-3 file:min-h-11 file:rounded-field file:border file:border-ink/70 file:bg-paper file:px-4 file:font-semibold" />
          <p id="photos-hint" className="text-sm text-ink-soft">{t("chooseHint")}</p>
        </div>
      )}
      {needConsent && (
        <section aria-labelledby="consent-title" className="flex flex-col gap-3 rounded-field border border-door/40 bg-paper p-4">
          <h3 id="consent-title" className="font-semibold">{t("consentTitle")}</h3>
          <p className="text-[0.95rem]">{t("consentText")}</p>
          <Button type="button" onClick={allow} disabled={busy} className="self-start">{t("consentButton")}</Button>
        </section>
      )}
      {canAnalyze && !needConsent && (
        <div className="flex flex-wrap items-center gap-3">
          <Button type="button" onClick={send} disabled={busy || running}>
            {files.length > 0 ? `${t("analyze")} (${t("photos", { count: files.length })})` : analysed ? t("reanalyze") : t("analyze")}
          </Button>
          {analysed && <p className="text-sm text-ink-soft">{t("analyzeHint")}</p>}
        </div>
      )}
      {msg && <Notice tone={msg.tone}>{msg.text}</Notice>}
    </div>
  );
}
