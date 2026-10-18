// Shapes of the P7 answers (docs/openapi.yaml: Flatmate, SavedSearch, D-106). Display only: the score and the factor
// states are computed by the API (social.compatibility); the website never recomputes them.
import type { UserRef } from "@/lib/contact";

export type FactorState = "match" | "differs" | "unknown";
export interface Compatibility { score: number | null; factors: { factor: string; state: FactorState }[] }
export interface FlatmateProfile { user: UserRef; visible: boolean; headline: string | null; bio: string | null;
  seeking: "room" | "flatmate" | "both"; areas: string[]; move_in_from: string | null; updated_at: string;
  compatibility?: Compatibility }
export interface SavedSearch { saved_search_id: string; name: string; query: Record<string, string>; alert: "none" | "daily";
  last_alert_at: string | null; created_at: string; hits: number }

/** /search link of a saved query, in the page's own parameter names (lib/search readForm). The budget is left out: the
 *  page takes it in main units, the saved query holds minor units. */
export function searchHref(q: Record<string, string>): string {
  const map: Record<string, string> = { jurisdiction: "country", near: "near", q: "q", kind: "kind",
    furnished: "furnished", bills_included: "bills", available_by: "available_by" };
  const u = new URLSearchParams();
  for (const [k, v] of Object.entries(q)) if (map[k]) u.set(map[k], v);
  return `/search?${u.toString()}`;
}
