"use client";
// The "More" menu of the header: a native <details>, closed again by a click outside, Escape or a new page.
import { useEffect, useRef, type ReactNode } from "react";
import { usePathname } from "@/i18n/navigation";

export function HeaderMenu({ label, children, className }: { label: ReactNode; children: ReactNode; className?: string }) {
  const ref = useRef<HTMLDetailsElement>(null);
  const path = usePathname();
  useEffect(() => { if (ref.current) ref.current.open = false; }, [path]);
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
  return (
    <details ref={ref} className={`relative ${className || ""}`}>
      <summary className="flex min-h-10 cursor-pointer items-center gap-1.5 rounded-full px-3 text-[0.95rem] font-medium text-ink hover:bg-raised">
        {label}
        <svg viewBox="0 0 12 12" aria-hidden="true" className="size-3" fill="none" stroke="currentColor" strokeWidth="1.6"><path d="M2.5 4.5 6 8l3.5-3.5" /></svg>
      </summary>
      <div className="panel absolute end-0 top-full z-50 mt-2 flex w-64 flex-col gap-0.5 p-2 shadow-[var(--shadow-lift)]">
        {children}
      </div>
    </details>
  );
}
