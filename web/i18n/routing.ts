import { defineRouting } from "next-intl/routing";

// French first (Tunisia and France), then English and Arabic (right to left).
export const routing = defineRouting({
  locales: ["fr", "en", "ar"],
  defaultLocale: "fr",
  localePrefix: "always",
});

export type Locale = (typeof routing.locales)[number];
export const rtlLocales: readonly Locale[] = ["ar"];
export const dirOf = (locale: string) => (rtlLocales.includes(locale as Locale) ? "rtl" : "ltr");
