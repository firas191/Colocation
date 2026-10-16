// French, English and Arabic have the same message keys, and every ICU message parses in its language.
import { describe, expect, it } from "vitest";
import { createTranslator } from "next-intl";
import fr from "@/messages/fr.json";
import en from "@/messages/en.json";
import ar from "@/messages/ar.json";

type Tree = { [k: string]: string | string[] | Tree };
const keys = (t: Tree, p = ""): string[] =>
  Object.entries(t).flatMap(([k, v]) => (typeof v === "object" && !Array.isArray(v) ? keys(v as Tree, `${p}${k}.`) : [`${p}${k}`]));

describe("messages", () => {
  it("same keys in every language", () => {
    const f = keys(fr as Tree).sort();
    expect(keys(en as Tree).sort()).toEqual(f);
    expect(keys(ar as Tree).sort()).toEqual(f);
  });
  for (const [locale, messages] of Object.entries({ fr, en, ar })) {
    it(`${locale}: plural and placeholder messages format`, () => {
      const t = createTranslator({ locale, messages });
      for (const n of [0, 1, 2, 3, 11, 100]) expect(t("nav.unread", { count: n })).not.toContain("{");
      expect(t("auth.verify.body", { email: "a@b.c" })).toContain("a@b.c");
      expect(t("profile.version", { version: 2, date: "x" })).toContain("2");
    });
  }
  it("every API error code has a text", () => {
    for (const c of ["UNAUTHENTICATED", "FORBIDDEN", "VALIDATION_FAILED", "NOT_FOUND", "CONSENT_REQUIRED", "RATE_LIMITED",
      "CONFLICT", "UPSTREAM_UNAVAILABLE", "POLICY_BLOCKED", "INTERNAL", "PAYLOAD_TOO_LARGE", "EXTRACTION_FAILED"]) {
      for (const m of [fr, en, ar]) expect((m.errors as Record<string, string>)[c]).toBeTruthy();
    }
  });
});
