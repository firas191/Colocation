// The four steps of posting, with the current one marked. Display only: the listing's state decides the step.
import { getTranslations } from "next-intl/server";
import { clsx } from "clsx";

const STEPS = ["text", "photos", "check", "publish"] as const;
export type Step = (typeof STEPS)[number];

export async function Steps({ current }: { current: Step }) {
  const t = await getTranslations("owner.steps");
  const at = STEPS.indexOf(current);
  return (
    <nav aria-label={t("label")}>
      <ol className="grid grid-cols-4 gap-2 text-sm">
        {STEPS.map((s, i) => (
          <li key={s} aria-current={i === at ? "step" : undefined} className="relative flex flex-col items-center gap-2 text-center">
            {i > 0 && <span aria-hidden="true" className={clsx("absolute top-4 h-0.5 w-[calc(100%-2.5rem)] -translate-y-1/2 end-[calc(50%+1.25rem)]", i <= at ? "bg-olive" : "bg-line")} />}
            <span className={clsx("relative z-10 grid size-8 place-items-center rounded-full font-[family-name:var(--font-display)] font-bold ltr-island",
              i < at ? "bg-olive text-olive-ink" : i === at ? "bg-door text-door-ink ring-4 ring-door-soft" : "border border-line bg-paper text-ink-soft")}>
              {i < at ? <svg viewBox="0 0 12 12" aria-hidden="true" className="size-3.5" fill="none" stroke="currentColor" strokeWidth="2.2"><path d="m2.5 6.5 2.5 2.5 4.5-5" /></svg> : i + 1}
            </span>
            <span className={i === at ? "font-semibold" : "text-ink-soft"}>{t(s)}{i === at && <span className="sr-only"> ({t("current")})</span>}</span>
          </li>
        ))}
      </ol>
    </nav>
  );
}
