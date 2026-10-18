// /admin (platform P11, D-110): the staff pages. Moderators see moderation, prompts, evaluation runs, sources and
// traces; settings and roles are for admins (the API checks the role on every call).
import { notFound } from "next/navigation";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { Link } from "@/i18n/navigation";
import { requireMember } from "@/lib/server/guard";

export async function generateMetadata() {
  return { title: (await getTranslations("admin"))("title") };
}

export default async function Admin({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const me = await requireMember(locale);
  if (!me.flags.is_staff) notFound();
  const t = await getTranslations("admin");
  const pages = [["moderation", true], ["prompts", true], ["eval", true], ["kb", true], ["traces", true], ["settings", me.role === "admin"],
    ["users", me.role === "admin"]] as const;
  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-6">
      <h1 className="page-title">{t("title")}</h1>
      <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {pages.filter(([, ok]) => ok).map(([p]) => (
          <li key={p}>
            <Link href={`/admin/${p}`} className="panel flex min-h-24 items-end p-5 font-[family-name:var(--font-display)] text-lg font-semibold text-ink no-underline transition-shadow hover:border-door hover:text-door hover:shadow-[var(--shadow-lift)]">
              {t(`pages.${p}`)}
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
