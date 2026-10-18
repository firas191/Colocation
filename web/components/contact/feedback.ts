// The sentence for an API answer: a known issue code first (blocked, slot_full...), then the error code.
type T = { has: (k: string) => boolean; (k: string): string };
export function failure(r: { error?: string; issue?: string }, t: T, e: T) {
  if (r.error === "RATE_LIMITED") return t("rateLimited");
  if (r.issue && t.has(`issues.${r.issue}`)) return t(`issues.${r.issue}`);
  return r.error && e.has(r.error) ? e(r.error) : t("failed");
}
