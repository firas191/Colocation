// The page's one drawing: the floor plan of a shared flat, with the free room in the door colour.
// Labels come from the current language; the plan itself is not mirrored for Arabic (a plan has no reading
// direction), only its text is.
type Labels = { caption: string; kitchen: string; living: string; bath: string; room: string; free: string; entrance: string };

export function FloorPlan({ labels, className }: { labels: Labels; className?: string }) {
  const wall = "stroke-ink";
  return (
    <figure className={className}>
      <svg viewBox="0 0 480 360" role="img" aria-labelledby="plan-caption" className="h-auto w-full">
        <title id="plan-caption">{labels.caption}</title>
        <g fill="none" strokeLinecap="square" className="plan-draw">
          {/* free room: filled first so the walls sit on top */}
          <rect x="310" y="125" width="150" height="105" className="fill-door/15 stroke-none" />
          {/* outer walls, with the entrance gap at the bottom */}
          <path d="M20 20 H460 V340 H95 M55 340 H20 V20" strokeWidth="5" className={wall} />
          {/* inner walls; gaps are doors */}
          <path d="M170 20 V110 M20 150 H75 M105 150 H170 M120 150 V180 M120 210 V340 M20 240 H85 M310 20 V70 M310 100 V175
                   M310 205 V285 M310 315 V340 M310 125 H460 M310 230 H460" strokeWidth="2.5" className={wall} />
          {/* door leaves and their swing */}
          <g strokeWidth="1.2" className="stroke-ink-soft">
            <path d="M310 70 L340 70 M340 70 A30 30 0 0 1 310 100" />
            <path d="M310 175 L340 175 M340 175 A30 30 0 0 1 310 205" className="stroke-door" strokeWidth="2" />
            <path d="M310 285 L340 285 M340 285 A30 30 0 0 1 310 315" />
            <path d="M120 180 L90 180 M90 180 A30 30 0 0 0 120 210" />
            <path d="M75 150 L75 120 M75 120 A30 30 0 0 1 105 150" />
            <path d="M55 340 L55 310 M55 310 A40 40 0 0 1 95 340" />
          </g>
          {/* furniture, light */}
          <g strokeWidth="1" className="stroke-ink-soft/70">
            <rect x="414" y="45" width="38" height="68" rx="3" />
            <rect x="414" y="150" width="38" height="68" rx="3" className="stroke-door" />
            <rect x="414" y="262" width="38" height="68" rx="3" />
            <rect x="30" y="30" width="130" height="22" />
            <circle cx="70" cy="95" r="18" />
            <rect x="185" y="250" width="100" height="40" rx="6" />
            <rect x="30" y="160" width="40" height="24" rx="10" />
          </g>
        </g>
        <g className="fill-ink text-[13px] font-semibold" textAnchor="middle">
          <text x="128" y="100">{labels.kitchen}</text>
          <text x="240" y="150">{labels.living}</text>
          <text x="70" y="222">{labels.bath}</text>
          <text x="70" y="298">{labels.entrance}</text>
          <text x="368" y="44">{labels.room}</text>
          <text x="368" y="148" className="fill-door">{labels.free}</text>
          <text x="368" y="253">{labels.room}</text>
        </g>
      </svg>
    </figure>
  );
}

export function LogoMark({ className }: { className?: string }) {
  // a door seen from above: the leaf and its swing
  return (
    <svg viewBox="0 0 32 32" aria-hidden="true" className={className}>
      <path d="M5 27 H27" className="stroke-ink" strokeWidth="3" fill="none" />
      <path d="M8 27 V7" className="stroke-door" strokeWidth="3" fill="none" />
      <path d="M8 7 A20 20 0 0 1 27 26" className="stroke-door" strokeWidth="1.6" fill="none" strokeDasharray="2.5 2.5" />
    </svg>
  );
}
