import { clsx } from "clsx";
import type { InputHTMLAttributes, ReactNode, SelectHTMLAttributes, TextareaHTMLAttributes } from "react";

const control = "block w-full min-h-11 rounded-field border border-line bg-paper px-3 text-base text-ink placeholder:text-ink-soft/70 " +
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
        className="mt-0.5 size-5 shrink-0 accent-door" />
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
            <span className="inline-flex min-h-10 cursor-pointer items-center rounded-full border border-line bg-paper px-4 text-sm
              peer-checked:border-door peer-checked:bg-door peer-checked:text-door-ink peer-focus-visible:outline-2 peer-focus-visible:outline-door">
              {o.label}
            </span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

export function Notice({ tone = "info", children }: { tone?: "info" | "ok" | "error"; children: ReactNode }) {
  const t = { info: "border-door/40 bg-door/5", ok: "border-olive/50 bg-olive/10", error: "border-brick/50 bg-brick/10" }[tone];
  return <p role={tone === "error" ? "alert" : "status"} className={clsx("rounded-field border-s-4 px-4 py-3 text-[0.95rem]", t)}>{children}</p>;
}
