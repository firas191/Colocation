"use client";
// Light or dark (D-116). The first visit follows the system; a click picks the other theme, remembers it in a cookie
// (read by the server, so the next page is painted in it from the start) and tells the map to restyle.
export function ThemeToggle({ label }: { label: string }) {
  const flip = () => {
    const root = document.documentElement;
    const now = root.dataset.theme || (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
    const next = now === "dark" ? "light" : "dark";
    root.dataset.theme = next;
    try { document.cookie = `theme=${next}; path=/; max-age=31536000; samesite=lax`; } catch { /* cookies off: this page only */ }
    window.dispatchEvent(new CustomEvent("themechange", { detail: next }));
  };
  return (
    <button type="button" onClick={flip} aria-label={label} title={label}
      className="grid size-10 place-items-center rounded-full text-ink transition-colors hover:bg-raised">
      <svg viewBox="0 0 24 24" aria-hidden="true" className="theme-moon size-5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5Z" />
      </svg>
      <svg viewBox="0 0 24 24" aria-hidden="true" className="theme-sun size-5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
        <circle cx="12" cy="12" r="4" />
        <path d="M12 2.5v2M12 19.5v2M4.6 4.6l1.4 1.4M18 18l1.4 1.4M2.5 12h2M19.5 12h2M4.6 19.4 6 18M18 6l1.4-1.4" />
      </svg>
    </button>
  );
}

/** The current theme as the page shows it (data-theme, else the system). For the map. */
export function currentTheme(): "light" | "dark" {
  if (typeof document === "undefined") return "light";
  const t = document.documentElement.dataset.theme;
  if (t === "dark" || t === "light") return t;
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}
