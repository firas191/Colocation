"use client";
// The assistant (platform P2): the same orchestrator and agents as the Telegram bot. The conversation is kept in this
// tab only (the backend stores no message text, D-062); the agents keep their own short memory, as with Telegram.
// An agent answer can take a minute on the owner's PC, so the page says it is waiting and never sends twice.
import { useEffect, useRef, useState, useTransition } from "react";
import { useFormatter, useLocale, useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { Notice, Textarea } from "@/components/ui/field";
import { ListingCard } from "@/components/listing/listing-card";
import { BotText, ProposalBox, Thinking, Turn } from "@/components/ui/assistant";
import { Link, useRouter } from "@/i18n/navigation";
import { decideChangeAction, sendMessageAction, type Change, type Reply } from "@/lib/actions/assistant";

type Turn = { id: string; who: "you"; text: string } | { id: string; who: "bot"; reply: Reply };

/** compact: the narrow panel beside the owner's listings (one column of cards). */
export function Chat({ examples, compact = false, placeholder }: { examples: string[]; compact?: boolean; placeholder?: string }) {
  const t = useTranslations("assistant");
  const locale = useLocale();
  const [turns, setTurns] = useState<Turn[]>([]);
  const [text, setText] = useState("");
  const [pending, start] = useTransition();
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => { end.current?.scrollIntoView({ block: "nearest" }); }, [turns, pending]);

  const send = (msg: string) => {
    const m = msg.trim();
    if (!m || pending) return;
    setTurns((x) => [...x, { id: crypto.randomUUID(), who: "you", text: m }]);
    setText("");
    start(async () => {
      const reply = await sendMessageAction(locale, m).catch(() => ({ ok: false, error: "UPSTREAM_UNAVAILABLE" } as Reply));
      setTurns((x) => [...x, { id: crypto.randomUUID(), who: "bot", reply }]);
    });
  };

  return (
    <div className="flex flex-col gap-6">
      <ol className="flex flex-col gap-6" aria-live="polite">
        {turns.map((x) => (
          <li key={x.id}>
            {x.who === "you"
              ? <Turn who="you" label={t("you")}>{x.text}</Turn>
              : <Turn who="bot" label={t("bot")}><BotReply r={x.reply} compact={compact} /></Turn>}
          </li>
        ))}
        {pending && <Thinking as="li">{t("sending")}</Thinking>}
      </ol>
      <div ref={end} />
      <form onSubmit={(ev) => { ev.preventDefault(); send(text); }}
        className="panel flex flex-col gap-3 p-3 shadow-[var(--shadow-lift)] focus-within:border-door">
        <label htmlFor="msg" className="px-1 text-sm font-semibold">{t("label")}</label>
        <Textarea id="msg" value={text} onChange={(ev) => setText(ev.target.value)} placeholder={placeholder || t("placeholder")} maxLength={2000} rows={3}
          className="border-0 bg-transparent focus:shadow-none"
          onKeyDown={(ev) => { if (ev.key === "Enter" && !ev.shiftKey) { ev.preventDefault(); send(text); } }} />
        <div className="flex flex-wrap items-center gap-4">
          <Button type="submit" disabled={pending || !text.trim()}>{t("send")}</Button>
          {turns.length > 0 && !pending && <Button type="button" variant="quiet" onClick={() => setTurns([])}>{t("clear")}</Button>}
        </div>
      </form>
      {turns.length === 0 && (
        <section aria-labelledby="ex-title" className="flex flex-col gap-2">
          <h2 id="ex-title" className="text-sm font-semibold">{t("examples")}</h2>
          <ul className="flex flex-wrap gap-2">
            {examples.map((ex) => (
              <li key={ex}><button type="button" onClick={() => send(ex)} className="chip min-h-10 px-4 text-start transition-colors hover:border-door hover:text-door">{ex}</button></li>
            ))}
          </ul>
        </section>
      )}
      <p className="text-sm text-ink-soft">{t("privacy")}</p>
    </div>
  );
}

function BotReply({ r, compact }: { r: Reply; compact: boolean }) {
  const t = useTranslations("assistant");
  const e = useTranslations("errors");
  if (!r.ok) return <Notice tone="error">{r.error && e.has(r.error) ? e(r.error) : t("error")}</Notice>;
  if (r.intent === "legal_question" && (r.status === "answered" || r.status === "abstained")) return <LegalReply r={r} />;
  if (r.proposal) return <Proposal r={r} />;
  const fallback = r.status && t.has(`status.${r.status}`) ? t(`status.${r.status}`) : null;
  const text = r.clarifying_question || r.answer || (r.status === "results" ? null : fallback);
  return (
    <div className="flex flex-col gap-4">
      {text && <BotText>{text}</BotText>}
      {r.results && (
        <>
          <p className="font-semibold">{t("results", { count: r.results.length })}</p>
          {r.results.length > 0 && (
            <ul className={compact ? "grid gap-4" : "grid gap-4 sm:grid-cols-2 lg:grid-cols-3"}>
              {r.results.slice(0, 6).map((c) => <li key={c.id}><ListingCard c={c} /></li>)}
            </ul>
          )}
          {r.jurisdiction && r.results.length > 6 && <Link href={`/search?country=${r.jurisdiction}`} className="link-action">{t("seeAll")}</Link>}
        </>
      )}
    </div>
  );
}

function LegalReply({ r }: { r: Reply }) {
  const t = useTranslations("assistant.legal");
  const fmt = useFormatter();
  const date = (d?: string | null) => (d ? fmt.dateTime(new Date(d), { dateStyle: "medium" }) : null);
  return (
    <div className="flex flex-col gap-3 rounded-panel rounded-ss-sm border border-line bg-paper px-4 py-3">
      {r.abstained || !r.answer ? <p>{t("notFound")}</p> : (
        <>
          {r.conflict && <p className="font-semibold text-saffron">{t("conflict")}</p>}
          {/* the [n] markers refer to the numbered sources below (D-087) */}
          <p className="whitespace-pre-line">{r.answer}</p>
        </>
      )}
      {(r.citations || []).length > 0 && !r.abstained && (
        <div>
          <p className="text-sm font-semibold">{t("sources")}</p>
          <ol className="mt-1 flex flex-col gap-1 text-sm">
            {(r.citations || []).map((c) => (
              <li key={c.n}>
                <span className="ltr-island">[{c.n}]</span>{" "}
                {c.url ? <a href={c.url} target="_blank" rel="noreferrer noopener">{c.title || c.url}</a> : (c.title || "")}
                {c.article ? ` · ${c.article}` : ""}
                {c.source_type && t.has(`types.${c.source_type}`) ? ` · ${t(`types.${c.source_type}`)}` : ""}
                {c.retrieved_at ? ` · ${t("retrieved", { date: date(c.retrieved_at) || "" })}` : ""}
              </li>
            ))}
          </ol>
        </div>
      )}
      <p className="border-t border-line pt-2 text-sm text-ink-soft">{t("notice")}</p>
    </div>
  );
}

function Proposal({ r }: { r: Reply }) {
  const t = useTranslations("assistant.owner");
  const s = useTranslations("search");
  const fmt = useFormatter();
  const p = r.proposal!;
  const [done, setDone] = useState<null | { tone: "ok" | "info" | "error"; text: string }>(null);
  const [pending, start] = useTransition();
  const router = useRouter();
  const value = (c: Change, v: unknown): string => {
    if (v === null || v === undefined) return "—";
    if (typeof v === "boolean") return v ? s("yes") : s("no");
    if (typeof v === "number" && (c.field === "rent" || c.field === "deposit") && c.currency) {
      // rent and deposit in a proposal are in main units with their currency (ListingChange)
      return fmt.number(v, { style: "currency", currency: c.currency, maximumFractionDigits: 3, minimumFractionDigits: 0 });
    }
    if (Array.isArray(v)) return v.join(", ");
    if (typeof v === "object") return Object.entries(v as Record<string, unknown>).map(([k, x]) => `${k}: ${String(x)}`).join(", ");
    return String(v);
  };
  const decide = (d: "confirm" | "cancel") => start(async () => {
    const res = await decideChangeAction(d, p.listing_id, p.change_id, `chg-${d}-${crypto.randomUUID()}`);
    if (res.ok) {
      setDone({ tone: "ok", text: d === "confirm" ? (res.status === "published" ? `${t("confirmed")} ${t("published")}` : t("confirmed")) : t("cancelled") });
      if (d === "confirm") router.refresh();          // a page showing the listing (the owner's list) shows the change
    }
    else if (res.error === "CONFLICT" || res.issue === "expired" || (res.issue || "").startsWith("already_")) setDone({ tone: "info", text: t("gone") });
    else setDone({ tone: "error", text: t("refused") });
  });
  return (
    <div className="flex flex-col gap-3">
      {r.answer && <BotText>{r.answer}</BotText>}
      <ProposalBox title={t("proposed")} saved={done?.tone === "ok"} savedLabel={t("confirmed")}>
        <ul className="flex flex-col gap-2 text-[0.95rem]">
          {p.diff.map((c) => (
            <li key={c.field} className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
              <span className="font-semibold">{t.has(`fields.${c.field}`) ? t(`fields.${c.field}`) : c.field}</span>
              <span className="text-ink-soft line-through decoration-ink-soft/60">{value(c, c.before)}</span>
              <span aria-hidden="true" className="inline-block text-ink-soft rtl:rotate-180">→</span>
              <span className="font-semibold">{value(c, c.after)}</span>
            </li>
          ))}
        </ul>
        {p.expires_at && !done && <p className="text-sm text-ink-soft">{t("expires", { time: fmt.dateTime(new Date(p.expires_at), { timeStyle: "short" }) })}</p>}
        {done ? <Notice tone={done.tone}>{done.text}</Notice> : (
          <div className="flex flex-wrap gap-3">
            <Button type="button" onClick={() => decide("confirm")} disabled={pending}>{t("confirm")}</Button>
            <Button type="button" variant="secondary" onClick={() => decide("cancel")} disabled={pending}>{t("cancel")}</Button>
          </div>
        )}
      </ProposalBox>
    </div>
  );
}
