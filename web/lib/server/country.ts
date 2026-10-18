// The country the reader chose in the header (D-118): a cookie, kept only if it is one of the countries the API offers;
// otherwise the account's country, otherwise Tunisia. Listings, flatmates and the assistant's searches use it.
import "server-only";
import { cookies } from "next/headers";
import type { Me } from "./viewer";

export const COUNTRY_COOKIE = "country";

export async function currentCountry(me: Pick<Me, "jurisdictions" | "jurisdiction_code"> | null): Promise<string> {
  const codes = (me?.jurisdictions || []).map((j) => j.code);
  const chosen = (await cookies()).get(COUNTRY_COOKIE)?.value;
  if (chosen && (codes.length === 0 || codes.includes(chosen))) return chosen;
  if (me?.jurisdiction_code && codes.includes(me.jurisdiction_code)) return me.jurisdiction_code;
  return codes.includes("TN") || codes.length === 0 ? "TN" : codes[0];
}
