import { getTranslations } from "next-intl/server";
import { Link } from "@/i18n/navigation";

// A page that does not exist: a closed door on the plan, and the way back.
export default async function NotFound() {
  const t = await getTranslations("errors");
  const n = await getTranslations("nav");
  return (
    <div className="mx-auto flex max-w-xl flex-col items-center gap-6 py-10 text-center">
      <svg viewBox="0 0 160 120" aria-hidden="true" className="w-48 text-ink" fill="none" stroke="currentColor" strokeLinecap="square">
        <path d="M10 100 H62 M98 100 H150" strokeWidth="5" />
        <path d="M62 100 V40" className="stroke-door" strokeWidth="4" />
        <path d="M62 40 A60 60 0 0 1 98 100" className="stroke-door" strokeWidth="1.6" strokeDasharray="4 4" />
      </svg>
      <p className="font-[family-name:var(--font-display)] text-6xl font-bold text-door ltr-island">404</p>
      <h1 className="page-title">{t("NOT_FOUND")}</h1>
      <Link href="/" className="btn btn-primary">{n("home")}</Link>
    </div>
  );
}
