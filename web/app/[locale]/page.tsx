// The home page (D-116). The hero opens on the plan of a shared flat, drawn in white on the night-blue blueprint
// panel, with the search right under the headline. Then the three moments of a flatshare (a real sequence), what
// protects people on the site, and the assistant, whose proposals are dashed until they are saved.
import { getTranslations, setRequestLocale } from "next-intl/server";
import { Link } from "@/i18n/navigation";
import { FloorPlan } from "@/components/floor-plan";
import { getViewer } from "@/lib/server/viewer";

function Icon({ d }: { d: string }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className="size-6 text-door" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      <path d={d} />
    </svg>
  );
}
const ICONS = {
  checked: "M12 3 4.5 6v5.5c0 4.6 3.2 8.3 7.5 9.5 4.3-1.2 7.5-4.9 7.5-9.5V6L12 3Zm-3.5 9 2.5 2.5 4.5-5",
  consent: "M8 11V8a4 4 0 1 1 8 0v3M6 11h12v9H6zM12 15v2",
  place: "M12 21s-6.5-5.6-6.5-11A6.5 6.5 0 0 1 18.5 10c0 5.4-6.5 11-6.5 11Zm0-8.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5Z",
  money: "M4 7h16v10H4zM4 10h16M8 14h3",
};

export default async function Home({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations("landing");
  const p = await getTranslations("plan");
  const fm = await getTranslations("flatmates");
  const hh = await getTranslations("home");
  const viewer = await getViewer();
  const labels = { caption: p("caption"), kitchen: p("kitchen"), living: p("living"), bath: p("bath"), room: p("room"),
    free: p("free"), entrance: p("entrance") };
  const steps = (["search", "match", "live"] as const).map((k) => ({ k, title: t(`steps.${k}`), text: t(`steps.${k}Text`) }));
  const factors: Array<[string, "match" | "differs" | "unknown"]> = [["schedule", "match"], ["smoking", "match"], ["pets", "differs"], ["guests", "unknown"]];
  return (
    <div className="flex flex-col gap-24">
      {/* hero */}
      <section className="grid items-center gap-10 lg:grid-cols-[1.05fr_1fr] lg:gap-14">
        <div className="flex flex-col gap-7">
          <h1 className="max-w-[14ch] font-[family-name:var(--font-display)] text-display font-bold tracking-[-0.03em] rtl:tracking-normal">
            {viewer ? t("welcomeBack", { name: viewer.user.name || "" }) : t("title")}
          </h1>
          <p className="max-w-[52ch] text-lg text-ink-soft sm:text-xl">{viewer ? t("welcomeLead") : t("lead")}</p>
          <form method="get" action={`/${locale}/search`} role="search" aria-label={t("goSearch")}
            className="panel flex flex-col gap-2 p-2 shadow-[var(--shadow-lift)] sm:flex-row sm:items-stretch sm:rounded-full sm:p-2">
            <label className="flex flex-1 flex-col justify-center rounded-full px-4 py-1.5 hover:bg-raised">
              <span className="text-xs font-semibold text-ink-soft">{t("where")}</span>
              <input name="near" placeholder={t("wherePlaceholder")} maxLength={120}
                className="bg-transparent text-base text-ink placeholder:text-ink-soft/70 focus:outline-none" />
            </label>
            <span aria-hidden="true" className="hidden w-px bg-line sm:block" />
            <label className="flex flex-col justify-center rounded-full px-4 py-1.5 hover:bg-raised sm:w-44">
              <span className="text-xs font-semibold text-ink-soft">{t("budget")}</span>
              <input name="max" inputMode="decimal" dir="ltr" placeholder="450"
                className="bg-transparent text-base text-ink placeholder:text-ink-soft/70 focus:outline-none rtl:text-end" />
            </label>
            <button className="btn btn-primary min-h-12 rounded-full px-7">{t("searchSubmit")}</button>
          </form>
          <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
            {viewer ? (
              <>
                <Link href="/flatmates" className="link-action">{t("goFlatmates")}</Link>
                <Link href="/households" className="link-action">{t("goHouseholds")}</Link>
                <Link href="/profile" className="link-action">{t("goProfile")}</Link>
              </>
            ) : (
              <>
                <Link href="/signup" className="btn btn-primary">{t("start")}</Link>
                <Link href="/login" className="link-action">{t("signIn")}</Link>
              </>
            )}
          </div>
        </div>
        <div className="relative">
          <div className="relative overflow-hidden rounded-[var(--radius-photo)] bg-night p-6 shadow-[var(--shadow-lift)] ring-1 ring-line sm:p-8"
            style={{ backgroundImage: "linear-gradient(rgb(255 255 255 / 0.05) 1px, transparent 1px), linear-gradient(90deg, rgb(255 255 255 / 0.05) 1px, transparent 1px)", backgroundSize: "24px 24px" }}>
            <FloorPlan labels={labels} variant="blueprint" className="w-full" />
          </div>
        </div>
      </section>

      {/* the three moments, in the order they happen */}
      <section aria-labelledby="steps-title" className="flex flex-col gap-8">
        <h2 id="steps-title" className="section-title text-2xl sm:text-3xl">{t("stepsTitle")}</h2>
        <ol className="grid gap-5 md:grid-cols-3">
          {steps.map((s, i) => (
            <li key={s.k} className="panel flex flex-col gap-4 p-6">
              <div className="flex items-baseline gap-3">
                <span aria-hidden="true" className="font-[family-name:var(--font-display)] text-4xl font-bold text-door/80 ltr-island">{i + 1}</span>
                <h3 className="text-xl font-semibold">{s.title}</h3>
              </div>
              <p className="text-ink-soft">{s.text}</p>
              <div aria-hidden="true" className="mt-auto rounded-field bg-raised p-4">
                {s.k === "search" && (
                  <div className="grid grid-cols-[1fr_1.2fr] gap-3">
                    <div className="flex flex-col gap-2">
                      {[0, 1, 2].map((n) => <div key={n} className={`h-6 rounded-md ${n === 0 ? "bg-door/25" : "bg-paper"}`} />)}
                    </div>
                    <div className="relative h-24 rounded-md bg-paper">
                      <span className="map-pin absolute start-[20%] top-[25%] scale-75" />
                      <span className="map-pin absolute start-[55%] top-[45%] scale-75" data-active="true" />
                      <span className="map-pin absolute start-[35%] top-[60%] scale-75" />
                    </div>
                  </div>
                )}
                {s.k === "match" && (
                  <ul className="flex flex-wrap gap-2 text-xs">
                    {factors.map(([f, st]) => (
                      <li key={f} className={`chip min-h-7 ${st === "match" ? "border-door text-door" : st === "differs" ? "border-saffron" : "text-ink-soft"}`}>
                        {fm(`factors.${f}`)} · {fm(`states.${st}`)}
                      </li>
                    ))}
                  </ul>
                )}
                {s.k === "live" && (
                  <ul className="flex flex-col gap-2 text-sm">
                    {(["money", "chores", "documents"] as const).map((k, n) => (
                      <li key={k} className="flex items-center gap-2 rounded-md bg-paper px-3 py-1.5">
                        <span className={`size-2 rounded-full ${n === 0 ? "bg-olive" : n === 1 ? "bg-saffron" : "bg-door"}`} />{hh(`nav.${k}`)}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </li>
          ))}
        </ol>
      </section>

      {/* what protects people: each line is something the platform does */}
      <section aria-labelledby="trust-title" className="grid gap-10 lg:grid-cols-[0.8fr_1.2fr]">
        <h2 id="trust-title" className="section-title max-w-[14ch] text-2xl sm:text-3xl">{t("trustTitle")}</h2>
        <ul className="grid gap-x-10 gap-y-8 sm:grid-cols-2">
          {(["checked", "consent", "place", "money"] as const).map((k) => (
            <li key={k} className="flex flex-col gap-3 border-t border-line pt-5">
              <Icon d={ICONS[k]} />
              <p className="text-[1.05rem] leading-relaxed">{t(`trust.${k}`)}</p>
            </li>
          ))}
        </ul>
      </section>

      {/* the assistant */}
      <section aria-labelledby="ai-title" className="grid items-center gap-10 rounded-[var(--radius-photo)] bg-door-soft p-6 sm:p-10 lg:grid-cols-2">
        <div className="flex flex-col gap-4">
          <h2 id="ai-title" className="section-title text-2xl sm:text-3xl">{t("assistantTitle")}</h2>
          <p className="max-w-[55ch] text-ink-soft">{t("assistantText")}</p>
          <Link href={viewer ? "/assistant" : "/signup"} className="btn btn-primary self-start">{t("goAssistant")}</Link>
        </div>
        <div aria-hidden="true" className="flex flex-col gap-3">
          <p className="max-w-[85%] self-end rounded-panel rounded-ee-sm bg-door px-4 py-3 text-door-ink">{t("assistantExample")}</p>
          <div className="proposal max-w-[90%] p-4">
            <p className="mb-2 text-sm font-semibold text-door">{t("assistantProposal")}</p>
            <div className="flex flex-col gap-2">
              <div className="h-3 w-3/4 rounded bg-door/20" /><div className="h-3 w-1/2 rounded bg-door/20" />
            </div>
          </div>
          <p className="self-start rounded-full border-[1.5px] border-olive bg-paper px-3 py-1 text-sm font-semibold text-olive">{t("assistantSaved")}</p>
        </div>
      </section>
    </div>
  );
}
