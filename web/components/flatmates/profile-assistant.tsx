"use client";
// Fill in the flatmate profile by chatting (agent A7, D-115, from Yosr's onboarding). The agent proposes; code drops a
// budget, place or date the person did not write; the person checks the list and saves it. Nothing is saved before.
import { useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import { useRouter } from "@/i18n/navigation";
import { Button } from "@/components/ui/button";
import { Field, Notice, Textarea } from "@/components/ui/field";
import { applyProposalAction, profileAssistantAction, type Proposal } from "@/lib/actions/flatmates";
import { BotText, ProposalBox, Thinking, Turn } from "@/components/ui/assistant";

export function ProfileAssistant({ currency }: { currency: string | null }) {
  const t = useTranslations("flatmates");
  const e = useTranslations("errors");
  const router = useRouter();
  const [pending, start] = useTransition();
  const [text, setText] = useState("");
  const [turns, setTurns] = useState<{ me: string; answer: string }[]>([]);
  const [proposal, setProposal] = useState<Proposal | null>(null);
  const [dropped, setDropped] = useState<string[]>([]);
  const [msg, setMsg] = useState<null | { tone: "ok" | "error"; text: string }>(null);
  const word = (v: unknown) => (typeof v === "string" && t.has(`values.${v}`) ? t(`values.${v}`) : String(v));
  const field = (k: string) => (t.has(`factors.${k}`) ? t(`factors.${k}`) : t.has(`fields.${k}`) ? t(`fields.${k}`) : k);
  const lines = (p: Proposal): [string, string][] => [
    ...Object.entries(p.lifestyle || {}).map(([k, v]) => [field(k), word(v)] as [string, string]),
    ...(["budget_min", "budget_max"] as const).filter((k) => p[k] !== undefined).map((k) => [field(k), `${p[k]}${currency ? ` ${currency}` : ""}`] as [string, string]),
    ...(p.areas ? [[field("areas"), p.areas.join(", ")] as [string, string]] : []),
    ...(p.move_in_from ? [[field("move_in_from"), p.move_in_from] as [string, string]] : []),
    ...(p.headline ? [[field("headline"), p.headline] as [string, string]] : []),
    ...(p.seeking ? [[field("seeking"), word(p.seeking)] as [string, string]] : []),
    ...(p.languages ? [[field("languages"), p.languages.join(", ")] as [string, string]] : []),
  ];
  const ask = () => start(async () => {
    setMsg(null);
    const said = text.trim();
    const r = await profileAssistantAction(said, `fmai-${crypto.randomUUID()}`);
    if (!r.ok || !r.data) { setMsg({ tone: "error", text: r.error === "RATE_LIMITED" ? e(r.error) : t("assistantFailed") }); return; }
    setTurns((x) => [...x, { me: said, answer: r.data!.answer }]);
    if (r.data.proposal) setProposal(r.data.proposal);
    setDropped([...new Set(r.data.dropped.map((d) => field(d.field)))]);
    setText("");
  });
  const save = () => start(async () => {
    if (!proposal) return;
    const r = await applyProposalAction(proposal, `fmok-${crypto.randomUUID()}`);
    if (r.ok) { setMsg({ tone: "ok", text: t("proposalSaved") }); setProposal(null); router.refresh(); }
    else setMsg({ tone: "error", text: r.error && e.has(r.error) ? e(r.error) : e("INTERNAL") });
  });
  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-ink-soft">{t("assistantLead")}</p>
      {turns.length > 0 && (
        <ol className="flex flex-col gap-4" aria-live="polite">
          {turns.map((x, i) => (
            <li key={i} className="flex flex-col gap-3">
              <Turn who="you">{x.me}</Turn>
              <Turn who="bot"><BotText>{x.answer}</BotText></Turn>
            </li>
          ))}
        </ol>
      )}
      <Field id="fm-ai" label={t("assistantLabel")}>
        <Textarea id="fm-ai" rows={3} maxLength={2000} value={text} onChange={(ev) => setText(ev.target.value)} />
      </Field>
      <Button type="button" onClick={ask} disabled={pending || !text.trim()} className="self-start">{t("send")}</Button>
      {pending && <Thinking>{t("thinking")}</Thinking>}
      {proposal && lines(proposal).length > 0 && (
        <ProposalBox title={t("proposalTitle")}>
          <dl className="grid gap-x-4 gap-y-1 text-sm sm:grid-cols-[auto_1fr]">
            {lines(proposal).map(([k, v]) => <div key={k} className="contents"><dt className="text-ink-soft">{k}</dt><dd className="font-semibold">{v}</dd></div>)}
          </dl>
          {dropped.length > 0 && <p className="text-xs text-ink-soft">{t("droppedNote", { fields: dropped.join(", ") })}</p>}
          <Button type="button" variant="primary" onClick={save} disabled={pending} className="self-start">{t("saveProposal")}</Button>
        </ProposalBox>
      )}
      {msg && <Notice tone={msg.tone}>{msg.text}</Notice>}
    </div>
  );
}
