"use client";
// A small menu for the header's pickers (country, language): the current choice with its sign, the others below.
// A native <details>, closed by a click outside, Escape or a choice. Each choice is a button with aria-pressed.
import { useEffect, useRef, type ReactNode } from "react";

export interface PickerOption { value: string; sign: ReactNode; text: string; lang?: string }

export function Picker({ label, value, options, onPick, disabled, compact, icon }:
  { label: string; value: string; options: PickerOption[]; onPick: (v: string) => void; disabled?: boolean; compact?: (o: PickerOption) => ReactNode;
    icon?: ReactNode }) {
  const ref = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    const close = (e: Event) => {
      const d = ref.current;
      if (!d?.open) return;
      if (e instanceof KeyboardEvent ? e.key === "Escape" : !d.contains(e.target as Node)) {
        d.open = false;
        if (e instanceof KeyboardEvent) d.querySelector("summary")?.focus();
      }
    };
    document.addEventListener("click", close);
    document.addEventListener("keydown", close);
    return () => { document.removeEventListener("click", close); document.removeEventListener("keydown", close); };
  }, []);
  const cur = options.find((o) => o.value === value) || options[0];
  return (
    <details ref={ref} className="relative">
      <summary aria-label={`${label}: ${cur?.text || ""}`} title={label}
        className={`flex min-h-10 cursor-pointer items-center gap-2 rounded-full border border-line bg-paper px-3 text-sm font-semibold text-ink transition-colors hover:border-door ${disabled ? "pointer-events-none opacity-60" : ""}`}>
        {icon ?? cur?.sign}
        <span>{compact ? compact(cur) : cur?.text}</span>
        <svg viewBox="0 0 12 12" aria-hidden="true" className="size-3 text-ink-soft" fill="none" stroke="currentColor" strokeWidth="1.6"><path d="M2.5 4.5 6 8l3.5-3.5" /></svg>
      </summary>
      <div role="group" aria-label={label} className="panel absolute end-0 top-full z-50 mt-2 flex min-w-48 flex-col gap-0.5 p-1.5 shadow-[var(--shadow-lift)]">
        {options.map((o) => (
          <button key={o.value} type="button" lang={o.lang} aria-pressed={o.value === value}
            onClick={() => { if (ref.current) ref.current.open = false; if (o.value !== value) onPick(o.value); }}
            className="flex items-center gap-3 rounded-field px-3 py-2 text-start text-[0.95rem] text-ink transition-colors hover:bg-raised aria-pressed:bg-door-soft aria-pressed:font-semibold aria-pressed:text-door">
            {o.sign}<span className="flex-1">{o.text}</span>
            {o.value === value && <svg viewBox="0 0 12 12" aria-hidden="true" className="size-3.5" fill="none" stroke="currentColor" strokeWidth="2"><path d="m2.5 6.5 2.5 2.5 4.5-5" /></svg>}
          </button>
        ))}
      </div>
    </details>
  );
}
