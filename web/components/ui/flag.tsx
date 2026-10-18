// Country flags for the country picker (D-118), drawn as small SVGs: flag emoji are not drawn on Windows (they show two
// letters), and the site must look the same everywhere. Simplified shapes, the right colours.
export function Flag({ code, className = "h-4 w-6" }: { code: string; className?: string }) {
  const box = `${className} shrink-0 overflow-hidden rounded-[3px] ring-1 ring-black/10`;
  if (code === "TN") return (
    <svg viewBox="0 0 30 20" aria-hidden="true" className={box}>
      <rect width="30" height="20" fill="#E70013" />
      <circle cx="15" cy="10" r="5" fill="#fff" />
      <circle cx="15" cy="10" r="3.75" fill="#E70013" />
      <circle cx="16" cy="10" r="3" fill="#fff" />
      <path d="m17.6 10-2.05.67 1.27-1.75v2.16l-1.27-1.75z" fill="#E70013" />
    </svg>
  );
  if (code === "FR") return (
    <svg viewBox="0 0 30 20" aria-hidden="true" className={box}>
      <rect width="10" height="20" fill="#002654" /><rect x="10" width="10" height="20" fill="#fff" /><rect x="20" width="10" height="20" fill="#CE1126" />
    </svg>
  );
  if (code === "GB") return (
    <svg viewBox="0 0 60 40" aria-hidden="true" className={box}>
      <rect width="60" height="40" fill="#012169" />
      <path d="M0 0 60 40M60 0 0 40" stroke="#fff" strokeWidth="8" />
      <path d="M0 0 60 40M60 0 0 40" stroke="#C8102E" strokeWidth="2.6" />
      <path d="M30 0v40M0 20h60" stroke="#fff" strokeWidth="12" />
      <path d="M30 0v40M0 20h60" stroke="#C8102E" strokeWidth="7" />
    </svg>
  );
  return <span aria-hidden="true" className={`${box} grid place-items-center bg-raised text-[0.55rem] font-bold`}>{code}</span>;
}

/** The language picker's sign: a globe. */
export function Globe({ className = "size-4" }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className={className} fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round">
      <circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3c2.6 2.6 3.8 5.6 3.8 9s-1.2 6.4-3.8 9c-2.6-2.6-3.8-5.6-3.8-9S9.4 5.6 12 3Z" />
    </svg>
  );
}
