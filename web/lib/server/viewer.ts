// Who is looking at the page, as the server knows it: the auth session, and the platform user behind it.
import "server-only";
import { cache } from "react";
import { createHash } from "node:crypto";
import { headers } from "next/headers";
import { auth, type AuthUser } from "./auth";
import { api, type ApiResult } from "./api";

export interface Me {
  user_id: string; email: string | null; display_name: string | null; role: "user" | "owner" | "moderator" | "admin";
  locale: string; jurisdiction_code: string | null; created_at: string;
  consents: Record<string, { granted: boolean; policy_version: string; granted_at: string }>;
  consent_required: string[];
  flags: { has_profile: boolean; has_listings: boolean; is_staff: boolean; telegram_linked: boolean };
  counts: { unread_notifications: number; listings: number };
  badges: unknown[];
  jurisdictions: Array<{ code: string; name: string; currency: string; exponent: number; languages?: string[] }>;
}

export async function clientIp(): Promise<string | null> {
  const h = await headers();
  const fwd = h.get("x-forwarded-for");
  return (fwd ? fwd.split(",")[0].trim() : h.get("x-real-ip")) || null;
}

/** Create or update the platform user for an auth user (POST /v1/users/sync) and remember its id. */
export async function syncPlatformUser(user: AuthUser, locale?: string): Promise<string | null> {
  const body = { external_auth_id: `web:${user.id}`, email: user.email, display_name: user.name?.slice(0, 100) || undefined,
    locale: locale || (user as { locale?: string }).locale || "fr" };
  // Same key for the same content: repeating the sync with unchanged data returns the stored answer.
  const key = "sync-" + createHash("sha256").update(JSON.stringify(body)).digest("hex").slice(0, 40);
  const r = await api<{ user_id: string }>("POST", "/v1/users/sync", { body, idempotencyKey: key, clientIp: await clientIp() });
  if (!r.ok) return null;
  if ((user as { platformUserId?: string }).platformUserId !== r.data.user_id) {
    const ctx = await auth.$context;
    await ctx.internalAdapter.updateUser(user.id, { platformUserId: r.data.user_id });
  }
  return r.data.user_id;
}

/** The signed-in viewer, once per request. null when nobody is signed in. */
export const getViewer = cache(async () => {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) return null;
  let userId = (session.user as { platformUserId?: string }).platformUserId || null;
  if (!userId) userId = await syncPlatformUser(session.user);
  return { user: session.user, userId };
});

/** GET /v1/me for the viewer. */
export const getMe = cache(async (): Promise<ApiResult<Me> | null> => {
  const v = await getViewer();
  if (!v?.userId) return null;
  return api<Me>("GET", "/v1/me", { userId: v.userId, clientIp: await clientIp() });
});
