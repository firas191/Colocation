// A person's initial in a circle. The colour comes from the name, so the same person keeps the same colour.
import { clsx } from "clsx";

const TONES = ["bg-door text-door-ink", "bg-bougain text-bougain-ink", "bg-olive text-olive-ink", "bg-saffron text-ink", "bg-ink text-paper"];

export function Avatar({ name, size = "md", className }: { name: string | null | undefined; size?: "sm" | "md" | "lg"; className?: string }) {
  const n = (name || "?").trim();
  let h = 0;
  for (const ch of n) h = (h * 31 + ch.codePointAt(0)!) >>> 0;
  return (
    <span aria-hidden="true" className={clsx("grid shrink-0 place-items-center rounded-full font-[family-name:var(--font-display)] font-bold uppercase",
      TONES[h % TONES.length], size === "sm" ? "size-8 text-xs" : size === "lg" ? "size-16 text-2xl" : "size-11 text-base", className)}>
      {[...n][0] || "?"}
    </span>
  );
}
