"use client";
import { useParams } from "next/navigation";
import { useTransition } from "react";
import { usePathname, useRouter } from "@/i18n/navigation";

const NAMES = { fr: "Français", en: "English", ar: "العربية" } as const;

export function LocaleSwitcher({ locale, label }: { locale: string; label: string }) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useParams();
  const [pending, start] = useTransition();
  return (
    <label className="flex items-center gap-2 text-sm">
      <span className="sr-only">{label}</span>
      <select
        value={locale}
        disabled={pending}
        onChange={(e) => start(() => router.replace(
          // @ts-expect-error -- params of the current route are passed back unchanged
          { pathname, params }, { locale: e.target.value }))}
        className="min-h-10 rounded-field border border-line bg-paper px-2 text-ink"
      >
        {Object.entries(NAMES).map(([code, name]) => <option key={code} value={code} lang={code}>{name}</option>)}
      </select>
    </label>
  );
}
