"use client";
import { useTranslations } from "next-intl";
import { Notice } from "@/components/ui/field";

// Shown when a page cannot reach the platform (for example the API is down during a guard check).
export default function PageError() {
  const t = useTranslations("errors");
  return <Notice tone="error">{t("UPSTREAM_UNAVAILABLE")}</Notice>;
}
