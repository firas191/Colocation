// The household's sections (platform P5, P6): what the caller's role may open (the owner member sees no money,
// chores or shopping list, PLATFORM_SPEC 7.3; the API refuses them anyway).
import { getTranslations } from "next-intl/server";
import { Link } from "@/i18n/navigation";

export async function HouseholdNav({ id, role, current }: { id: string; role: string; current: string }) {
  const t = await getTranslations("home.nav");
  const all = [["", "overview"], ["/money", "money"], ["/bills", "bills"], ["/chores", "chores"], ["/shopping", "shopping"], ["/rules", "rules"],
    ["/calendar", "calendar"], ["/issues", "issues"], ["/documents", "documents"], ["/move-out", "moveout"]] as const;
  const flatmateOnly = ["money", "chores", "shopping"];
  return (
    <nav aria-label={t("label")} className="-mx-1 overflow-x-auto border-b border-line">
      <ul className="flex min-w-max gap-1 px-1">
        {all.filter(([, k]) => role === "flatmate" || !flatmateOnly.includes(k)).map(([p, k]) => (
          <li key={k}>
            <Link href={`/households/${id}${p}`} aria-current={current === k ? "page" : undefined}
              className={`-mb-px inline-flex min-h-11 items-center border-b-2 px-3 text-[0.95rem] font-medium no-underline transition-colors ${current === k ? "border-door text-door" : "border-transparent text-ink-soft hover:border-line hover:text-ink"}`}>
              {t(k)}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}
