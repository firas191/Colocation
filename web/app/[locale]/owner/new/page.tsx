// /owner/new (platform P3): step 1 of posting, the owner's own text. Photos, analysis, corrections and publication
// follow on the listing's page.
import { getTranslations, setRequestLocale } from "next-intl/server";
import { Link } from "@/i18n/navigation";
import { NewListingForm } from "@/components/owner/new-listing-form";
import { Steps } from "@/components/owner/steps";
import { currentCountry } from "@/lib/server/country";
import { requireMember } from "@/lib/server/guard";

export async function generateMetadata() {
  const t = await getTranslations("owner");
  return { title: t("newTitle") };
}

export default async function NewListing({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const me = await requireMember(locale);
  const t = await getTranslations("owner");
  const def = await currentCountry(me);   // the country chosen in the header (D-118)
  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-8">
      <Link href="/owner/listings" className="link-back">{t("back")}</Link>
      <header className="flex flex-col gap-3">
        <h1 className="page-title">{t("newTitle")}</h1>
        <p className="max-w-prose text-ink-soft">{t("newLead")}</p>
      </header>
      <Steps current="text" />
      <NewListingForm jurisdictions={me.jurisdictions} defaultJurisdiction={def} />
    </div>
  );
}
