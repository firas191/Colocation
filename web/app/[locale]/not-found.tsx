import { getTranslations } from "next-intl/server";
import { Link } from "@/i18n/navigation";

export default async function NotFound() {
  const t = await getTranslations("errors");
  const n = await getTranslations("nav");
  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-3xl font-bold">{t("NOT_FOUND")}</h1>
      <Link href="/">{n("home")}</Link>
    </div>
  );
}
