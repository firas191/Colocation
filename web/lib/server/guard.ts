// Page guards. They only decide where to send the visitor; the API enforces every rule itself.
import "server-only";
import { redirect } from "@/i18n/navigation";
import { getMe, getViewer, type Me } from "./viewer";

export async function requireSignedIn(locale: string) {
  const v = await getViewer();
  if (!v) redirect({ href: "/login", locale });
  return v!;
}

/** Signed in, platform user known, terms and privacy accepted. Returns GET /v1/me. */
export async function requireMember(locale: string): Promise<Me> {
  await requireSignedIn(locale);
  const me = await getMe();
  if (!me || !me.ok) throw new Error(me && !me.ok ? me.error.code : "UPSTREAM_UNAVAILABLE");
  if (me.data.consent_required.length > 0) redirect({ href: "/consent", locale });
  return me.data;
}
