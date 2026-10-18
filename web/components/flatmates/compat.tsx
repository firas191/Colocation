// The compatibility the API computed (social.compatibility, D-106): the score over the answers both people gave, and
// each factor as same / different / not said. "Not said" is shown as such and never counted against anyone.
import { useTranslations } from "next-intl";
import type { Compatibility } from "@/lib/flatmates";

export function Compat({ c, full = false }: { c: Compatibility; full?: boolean }) {
  const t = useTranslations("flatmates");
  const known = c.factors.filter((f) => f.state !== "unknown");
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-3">
        {c.score !== null && (
          // the score as a ring: the part of the circle is the score out of 100
          <span aria-hidden="true" className="grid size-12 shrink-0 place-items-center rounded-full"
            style={{ background: `conic-gradient(var(--color-bougain) ${c.score * 3.6}deg, var(--color-raised) 0)` }}>
            <span className="grid size-9 place-items-center rounded-full bg-paper font-[family-name:var(--font-display)] text-sm font-bold ltr-island">{c.score}</span>
          </span>
        )}
        <div className="flex flex-col">
          <p className="font-semibold">{c.score === null ? t("noScore") : t("score", { score: c.score })}</p>
          {c.score !== null && <p className="text-sm text-ink-soft">{t("scoreBasis", { known: known.length, total: c.factors.length })}</p>}
        </div>
      </div>
      {full && (
        <ul className="flex flex-wrap gap-2 text-sm">
          {c.factors.map((f) => (
            <li key={f.factor} className={`rounded-full border px-3 py-1 ${f.state === "match" ? "border-door" : f.state === "differs" ? "border-saffron" : "border-line text-ink-soft"}`}>
              {t(`factors.${f.factor}`)} · {t(`states.${f.state}`)}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
