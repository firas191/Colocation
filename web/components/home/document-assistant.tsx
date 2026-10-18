"use client";
// The Document agent (platform P9, D-108): the person describes the document in words; the agent asks for what is
// missing and stores a proposal. The proposal shown is the stored draft (from the database), and nothing is made until
// the person confirms it.
import { useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import { useRouter } from "@/i18n/navigation";
import { Button } from "@/components/ui/button";
import { Field, Notice, Textarea } from "@/components/ui/field";
import { homeAction } from "@/lib/actions/home";
import { BotText, ProposalBox, Thinking, Turn } from "@/components/ui/assistant";

interface Draft { draft_id: string; kind: string; language: string; values: Record<string, unknown>; missing: string[] }

const show = (v: unknown): string => Array.isArray(v)
  ? v.map((r) => (r && typeof r === "object" ? Object.values(r as Record<string, unknown>).filter(Boolean).join(" · ") : String(r))).join(" / ")
  : String(v);

export function DocumentAssistant({ householdId }: { householdId: string }) {
  const t = useTranslations("documents");
  const e = useTranslations("errors");
  const router = useRouter();
  const [pending, start] = useTransition();
  const [text, setText] = useState("");
  const [answer, setAnswer] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [msg, setMsg] = useState<null | { tone: "ok" | "error"; text: string }>(null);
  const ask = () => start(async () => {
    setMsg(null);
    const r = await homeAction<{ answer: string; draft: Draft | null }>("POST", `/v1/households/${householdId}/documents/assistant`, { text: text.trim() },
      `docai-${crypto.randomUUID()}`);
    if (!r.ok) { setMsg({ tone: "error", text: r.error && e.has(r.error) ? e(r.error) : t("failed") }); return; }
    setAnswer(r.data?.answer || null);
    if (r.data?.draft) setDraft(r.data.draft);
    setText("");
  });
  const confirm = () => start(async () => {
    if (!draft) return;
    const r = await homeAction("POST", `/v1/households/${householdId}/documents`, { draft_id: draft.draft_id }, `docok-${crypto.randomUUID()}`);
    if (r.ok) { setMsg({ tone: "ok", text: t("made") }); setDraft(null); setAnswer(null); router.refresh(); }
    else setMsg({ tone: "error", text: r.issue === "required" ? t("stillMissing") : r.error && e.has(r.error) ? e(r.error) : t("failed") });
  });
  return (
    <div className="flex flex-col gap-3">
      <Field id="doc-ai" label={t("askLabel")} hint={t("askHint")}>
        <Textarea id="doc-ai" rows={3} maxLength={2000} value={text} onChange={(ev) => setText(ev.target.value)} />
      </Field>
      <Button type="button" onClick={ask} disabled={pending || !text.trim()} className="self-start">{t("ask")}</Button>
      {pending && <Thinking>{t("thinking")}</Thinking>}
      {answer && <div aria-live="polite"><Turn who="bot"><BotText>{answer}</BotText></Turn></div>}
      {draft && (
        <ProposalBox title={t("proposal", { kind: t(`kinds.${draft.kind}`) })}>
          <dl className="grid gap-x-4 gap-y-1 text-sm sm:grid-cols-[auto_1fr]">
            {Object.entries(draft.values).map(([k, v]) => (
              <div key={k} className="contents"><dt className="text-ink-soft">{t.has(`slots.${k}`) ? t(`slots.${k}`) : k}</dt><dd className="font-semibold">{show(v)}</dd></div>
            ))}
          </dl>
          {draft.missing.length > 0
            ? <Notice>{t("missing")} {draft.missing.map((m) => (t.has(`slots.${m}`) ? t(`slots.${m}`) : m)).join(", ")}</Notice>
            : <Button type="button" variant="primary" onClick={confirm} disabled={pending} className="self-start">{t("confirm")}</Button>}
        </ProposalBox>
      )}
      {msg && <Notice tone={msg.tone}>{msg.text}</Notice>}
    </div>
  );
}
