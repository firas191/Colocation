"use server";
// Notification channels (platform P11, D-110): preferences and the Telegram link code. One API call each.
import { revalidatePath } from "next/cache";
import { api } from "@/lib/server/api";
import { clientIp, getViewer } from "@/lib/server/viewer";

const KEY = /^[A-Za-z0-9_.:-]{8,128}$/;

export async function savePrefsAction(prefs: { email: boolean; telegram: boolean; muted: string[] }, idem: string) {
  const v = await getViewer();
  if (!v?.userId || !KEY.test(idem)) return { ok: false, error: "UNAUTHENTICATED" };
  const r = await api("PUT", "/v1/me/notification-preferences", { userId: v.userId, clientIp: await clientIp(), idempotencyKey: idem,
    body: { email: !!prefs.email, telegram: !!prefs.telegram, muted: prefs.muted.filter((m) => /^[a-z][a-z0-9_]{2,60}$/.test(m)).slice(0, 60) } });
  return r.ok ? { ok: true } : { ok: false, error: r.error.code };
}

export async function telegramLinkAction(on: boolean, idem: string): Promise<{ ok: boolean; error?: string; code?: string; expires_at?: string }> {
  const v = await getViewer();
  if (!v?.userId || !KEY.test(idem)) return { ok: false, error: "UNAUTHENTICATED" };
  const r = await api<{ code: string; expires_at: string }>(on ? "POST" : "DELETE", "/v1/me/telegram-link",
    { userId: v.userId, clientIp: await clientIp(), idempotencyKey: idem, body: on ? {} : undefined });
  if (!r.ok) return { ok: false, error: r.error.code };
  revalidatePath("/", "layout");
  return on ? { ok: true, code: r.data.code, expires_at: r.data.expires_at } : { ok: true };
}
