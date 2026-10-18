"use client";
// The language of the site: FR, EN or AR in the bar, the full names in the menu (D-118).
import { useParams } from "next/navigation";
import { useTransition } from "react";
import { usePathname, useRouter } from "@/i18n/navigation";
import { Globe } from "@/components/ui/flag";
import { Picker } from "@/components/ui/picker";

const NAMES = { fr: "Français", en: "English", ar: "العربية" } as const;

export function LocaleSwitcher({ locale, label }: { locale: string; label: string }) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useParams();
  const [pending, start] = useTransition();
  return (
    <Picker label={label} value={locale} disabled={pending} compact={(o) => o.value.toUpperCase()}
      icon={<span aria-hidden="true" className="text-door"><Globe /></span>}
      onPick={(v) => start(() => router.replace(
        // @ts-expect-error -- params of the current route are passed back unchanged
        { pathname, params }, { locale: v }))}
      options={Object.entries(NAMES).map(([code, name]) => ({ value: code, text: name, lang: code,
        sign: <span aria-hidden="true" className="grid h-5 w-7 place-items-center rounded bg-raised text-[0.7rem] font-bold text-ink-soft">{code.toUpperCase()}</span> }))} />
  );
}
