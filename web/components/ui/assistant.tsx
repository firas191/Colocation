// The one look of every assistant on the site (D-116): the search and owner assistant, the Document agent, the
// flatmate profile chat, legal answers. States: thinking (three dots, role=status), proposal (dashed, like a proposed
// wall on a plan: nothing is saved yet), saved (solid olive), failed (the error notice).
import { clsx } from "clsx";
import type { ReactNode } from "react";

export function AssistantMark({ className }: { className?: string }) {
  return (
    <span aria-hidden="true" className={clsx("relative grid size-8 shrink-0 place-items-center rounded-full bg-door text-door-ink", className)}>
      <svg viewBox="0 0 32 32" className="size-5" fill="none" stroke="currentColor">
        <path d="M9 25V8" strokeWidth="2.6" /><path d="M9 8a17 17 0 0 1 16 16" strokeWidth="1.6" strokeDasharray="2.4 2.4" />
      </svg>
      <span className="absolute -end-0.5 -top-0.5 size-2.5 rounded-full bg-bougain ring-2 ring-paper" />
    </span>
  );
}

/** One turn of a conversation. who="you": the person's words, at the end of the line; "bot": the assistant's. */
export function Turn({ who, label, children }: { who: "you" | "bot"; label?: string; children: ReactNode }) {
  if (who === "you") {
    return (
      <div className="ms-auto flex max-w-[85%] flex-col items-end gap-1">
        {label && <span className="text-xs font-semibold text-ink-soft">{label}</span>}
        <div className="rounded-panel rounded-ee-sm bg-door px-4 py-2.5 whitespace-pre-line text-door-ink [overflow-wrap:anywhere]">{children}</div>
      </div>
    );
  }
  return (
    <div className="flex w-full items-start gap-3">
      <AssistantMark className="mt-5" />
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        {label && <span className="text-xs font-semibold text-ink-soft">{label}</span>}
        {children}
      </div>
    </div>
  );
}

/** The assistant's words. */
export function BotText({ children }: { children: ReactNode }) {
  return <div className="rounded-panel rounded-ss-sm border border-line bg-paper px-4 py-3 whitespace-pre-line [overflow-wrap:anywhere]">{children}</div>;
}

/** The assistant is working. The text stays in the status, so screen readers hear it. */
export function Thinking({ children, as: As = "p" }: { children: ReactNode; as?: "p" | "li" | "div" }) {
  return (
    <As role="status" className="flex items-center gap-3 text-ink-soft">
      <AssistantMark />
      <span className="thinking-dots inline-flex gap-1 text-door" aria-hidden="true"><span /><span /><span /></span>
      <span>{children}</span>
    </As>
  );
}

/** What the assistant proposes: dashed until the person saves it, then solid. */
export function ProposalBox({ title, saved = false, savedLabel, children, className }:
  { title: ReactNode; saved?: boolean; savedLabel?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <div className={clsx("flex flex-col gap-3 p-4 transition-colors", saved ? "rounded-panel border-[1.5px] border-olive bg-paper" : "proposal", className)}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className={clsx("font-semibold", saved ? "text-olive" : "text-door")}>{title}</p>
        {saved && savedLabel && (
          <span className="inline-flex items-center gap-1.5 rounded-full bg-olive/15 px-2.5 py-0.5 text-xs font-semibold text-olive">
            <svg viewBox="0 0 12 12" aria-hidden="true" className="size-3" fill="none" stroke="currentColor" strokeWidth="2"><path d="m2.5 6.5 2.5 2.5 4.5-5" /></svg>
            {savedLabel}
          </span>
        )}
      </div>
      {children}
    </div>
  );
}
