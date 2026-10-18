"use client";
// The country of the site (D-118). The choice is a cookie the server reads; the page is drawn again for that country.
// On the search page the address's own country is dropped, so the new choice applies. The header is part of the
// layout, which a navigation alone does not draw again, so the page is also refreshed (the header kept showing the old
// country after a change on the search page).
import { useTransition } from "react";
import { usePathname, useRouter } from "@/i18n/navigation";
import { Flag } from "@/components/ui/flag";
import { Picker } from "@/components/ui/picker";

export function CountrySwitcher({ country, countries, label }: { country: string; countries: Array<{ code: string; name: string }>; label: string }) {
  const router = useRouter();
  const pathname = usePathname();
  const [pending, start] = useTransition();
  const pick = (code: string) => start(() => {
    try { document.cookie = `country=${code}; path=/; max-age=31536000; samesite=lax`; } catch { /* cookies off: nothing to keep */ }
    if (pathname.startsWith("/search")) router.replace(new URLSearchParams(window.location.search).get("view") === "map" ? "/search?view=map" : "/search");
    router.refresh();
  });
  return (
    <Picker label={label} value={country} onPick={pick} disabled={pending}
      options={countries.map((c) => ({ value: c.code, text: c.name, sign: <Flag code={c.code} /> }))} />
  );
}
