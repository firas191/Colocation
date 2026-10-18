"use client";
// Photos of a repair request (platform P6): upload URLs from the API, the bytes sent by the browser to the storage,
// then the API processes them (EXIF removed, faces and text blurred).
import { useRef, useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import { useRouter } from "@/i18n/navigation";
import { Button } from "@/components/ui/button";
import { Notice } from "@/components/ui/field";
import { homeAction } from "@/lib/actions/home";

export function IssuePhotos({ issueId }: { issueId: string }) {
  const t = useTranslations("home");
  const router = useRouter();
  const input = useRef<HTMLInputElement>(null);
  const [files, setFiles] = useState<File[]>([]);
  const [msg, setMsg] = useState<null | { tone: "ok" | "error" | "info"; text: string }>(null);
  const [pending, start] = useTransition();
  const send = () => start(async () => {
    const p = await homeAction("POST", `/v1/issues/${issueId}/photos/presign`,
      { files: files.map((f) => ({ content_type: f.type || "image/jpeg", bytes: f.size })) }, `ip-${crypto.randomUUID()}`);
    if (!p.ok) { setMsg({ tone: "error", text: t("failed") }); return; }
    for (let i = 0; i < p.data.uploads.length; i++) {
      setMsg({ tone: "info", text: t("sendingPhoto", { n: i + 1, total: p.data.uploads.length }) });
      const u = p.data.uploads[i];
      const r = await fetch(u.url, { method: "PUT", headers: u.headers, body: files[i] }).catch(() => null);
      if (!r || !r.ok) { setMsg({ tone: "error", text: t("failed") }); return; }
    }
    const done = await homeAction("POST", `/v1/issues/${issueId}/photos/process`, {}, `pp-${crypto.randomUUID()}`);
    setMsg(done.ok ? { tone: "ok", text: t("photosAdded", { count: done.data.processed }) } : { tone: "error", text: t("failed") });
    setFiles([]); if (input.current) input.current.value = "";
    router.refresh();
  });
  return (
    <div className="flex flex-col gap-2">
      <label htmlFor={`ph-${issueId}`} className="text-sm font-semibold">{t("addPhotos")}</label>
      <input ref={input} id={`ph-${issueId}`} type="file" multiple accept="image/jpeg,image/png,image/webp" className="block w-full max-w-full text-sm"
        onChange={(ev) => setFiles(Array.from(ev.target.files || []).slice(0, 6))} />
      {files.length > 0 && <Button type="button" variant="secondary" onClick={send} disabled={pending} className="self-start">{t("sendPhotos")}</Button>}
      {msg && <Notice tone={msg.tone}>{msg.text}</Notice>}
    </div>
  );
}
