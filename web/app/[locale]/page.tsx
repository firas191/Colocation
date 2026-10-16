import { getTranslations, setRequestLocale } from "next-intl/server";
import { Link } from "@/i18n/navigation";
import { FloorPlan } from "@/components/floor-plan";
import { getViewer } from "@/lib/server/viewer";

export default async function Home({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations("home");
  const p = await getTranslations("plan");
  const viewer = await getViewer();
  const labels = { caption: p("caption"), kitchen: p("kitchen"), living: p("living"), bath: p("bath"), room: p("room"),
    free: p("free"), entrance: p("entrance") };
  const steps = (["search", "match", "live"] as const).map((k) => ({ k, title: t(`steps.${k}`), text: t(`steps.${k}Text`) }));
  return (
    <div className="flex flex-col gap-14">
      <section className="grid items-center gap-10 md:grid-cols-[1.1fr_1fr]">
        <div className="flex flex-col gap-6">
          <h1 className="max-w-[16ch] text-4xl font-bold leading-[1.08] tracking-tight sm:text-display">
            {viewer ? t("welcomeBack", { name: viewer.user.name || "" }) : t("title")}
          </h1>
          <p className="max-w-[58ch] text-lg text-ink-soft">{t("lead")}</p>
          <div className="flex flex-wrap items-center gap-4">
            {viewer ? (
              <>
                <Link href="/search" className="inline-flex min-h-11 items-center rounded-field bg-door px-5 font-semibold text-door-ink no-underline">{t("goSearch")}</Link>
                <Link href="/profile">{t("goProfile")}</Link>
              </>
            ) : (
              <>
                <Link href="/signup" className="inline-flex min-h-11 items-center rounded-field bg-door px-5 font-semibold text-door-ink no-underline">{t("start")}</Link>
                <Link href="/login">{t("signIn")}</Link>
              </>
            )}
          </div>
        </div>
        <FloorPlan labels={labels} className="w-full" />
      </section>
      {/* The three moments of a flatshare happen in this order, so they are a sequence. */}
      <ol className="grid gap-8 border-t border-line pt-10 sm:grid-cols-3">
        {steps.map((s, i) => (
          <li key={s.k} className="flex flex-col gap-2">
            <span aria-hidden="true" className="text-sm font-semibold text-door ltr-island">{i + 1}</span>
            <h2 className="text-xl font-semibold">{s.title}</h2>
            <p className="text-ink-soft">{s.text}</p>
          </li>
        ))}
      </ol>
      <p className="max-w-prose text-sm text-ink-soft">{t("soon")}</p>
    </div>
  );
}
