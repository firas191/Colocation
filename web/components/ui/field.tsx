import { clsx } from "clsx";
import type { InputHTMLAttributes, ReactNode, SelectHTMLAttributes, TextareaHTMLAttributes } from "react";

const control = "block w-full min-h-11 rounded-field border border-line bg-paper px-3 text-base text-ink placeholder:text-ink-soft/70 " +
  "transition-[border-color,box-shadow] hover:border-ink-soft/60 focus:border-door focus:shadow-[0_0_0_3px_var(--color-door-soft)] focus:outline-none " +
  "aria-[invalid=true]:border-brick";

export function Field({ id, label, hint, error, children, className }:
  { id: string; label: ReactNode; hint?: ReactNode; error?: string | null; children: ReactNode; className?: string }) {
  return (
    <div className={clsx("flex flex-col gap-1.5", className)}>
      <label htmlFor={id} className="text-sm font-semibold">{label}</label>
      {children}
      {hint && <p id={`${id}-hint`} className="text-sm text-ink-soft">{hint}</p>}
      {error && <p id={`${id}-error`} className="text-sm font-medium text-brick" role="alert">{error}</p>}
    </div>
  );
}

export function describedBy(id: string, hint?: unknown, error?: unknown) {
  return [hint ? `${id}-hint` : null, error ? `${id}-error` : null].filter(Boolean).join(" ") || undefined;
}

export function Input({ className, ...p }: InputHTMLAttributes<HTMLInputElement>) {
  return <input {...p} className={clsx(control, className)} />;
}

export function Select({ className, ...p }: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select {...p} className={clsx(control, "pe-8", className)} />;
}

export function Textarea({ className, ...p }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea {...p} className={clsx(control, "min-h-24 py-2 leading-relaxed", className)} />;
}

export function Check({ name, label, defaultChecked, required, id }:
  { name: string; label: ReactNode; defaultChecked?: boolean; required?: boolean; id: string }) {
  return (
    <div className="flex items-start gap-3">
      <input id={id} name={name} type="checkbox" defaultChecked={defaultChecked} required={required}
        className="mt-0.5 size-5 shrink-0 cursor-pointer accent-door" />
      <label htmlFor={id} className="leading-snug">{label}</label>
    </div>
  );
}

/** Three-way choice (yes / no / not said) as one row of radio buttons: one tap on a phone. */
export function Choice({ name, legend, options, value }:
  { name: string; legend: ReactNode; options: Array<{ value: string; label: string }>; value: string }) {
  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="mb-1.5 text-sm font-semibold">{legend}</legend>
      <div className="flex flex-wrap gap-2">
        {options.map((o) => (
          <label key={o.value} className="relative">
            <input type="radio" name={name} value={o.value} defaultChecked={value === o.value} className="peer sr-only" />
            <span className="inline-flex min-h-10 cursor-pointer items-center rounded-full border border-line bg-paper px-4 text-sm transition-colors
              hover:border-door peer-checked:border-door peer-checked:bg-door peer-checked:text-door-ink peer-focus-visible:outline-2 peer-focus-visible:outline-door">
              {o.label}
            </span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

const NOTICE = {
  info: { box: "border-door/30 bg-door-soft", dot: "bg-door" },
  ok: { box: "border-olive/40 bg-olive/10", dot: "bg-olive" },
  error: { box: "border-brick/40 bg-brick/10", dot: "bg-brick" },
};
export function Notice({ tone = "info", children }: { tone?: "info" | "ok" | "error"; children: ReactNode }) {
  const t = NOTICE[tone];
  return (
    <p role={tone === "error" ? "alert" : "status"} className={clsx("flex items-start gap-3 rounded-field border px-4 py-3 text-[0.95rem]", t.box)}>
      <span aria-hidden="true" className={clsx("mt-2 size-2 shrink-0 rounded-full", t.dot)} />
      <span className="min-w-0 flex-1">{children}</span>
    </p>
  );
}

/** A page's title block: the title, an optional line under it and actions at the end. */
export function PageHeader({ title, lead, actions, back }: { title: ReactNode; lead?: ReactNode; actions?: ReactNode; back?: ReactNode }) {
  return (
    <header className="flex flex-col gap-3">
      {back && <div className="text-sm">{back}</div>}
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="flex min-w-0 flex-col gap-2">
          <h1 className="page-title">{title}</h1>
          {lead && <p className="max-w-[65ch] text-lg text-ink-soft">{lead}</p>}
        </div>
        {actions && <div className="flex flex-wrap items-center gap-3">{actions}</div>}
      </div>
    </header>
  );
}

/** An empty list: what is missing and, when there is one, the action that fills it. */
export function Empty({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-start gap-3 rounded-panel border border-dashed border-line px-5 py-6 text-ink-soft">
      <p>{children}</p>
      {action}
    </div>
  );
}
