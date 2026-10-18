"use server";
// Moderation (platform P8, D-107): one decision per call. The API checks the role (moderator or admin) and writes the
// audit log; this only passes the moderator's choice on.
import { revalidatePath } from "next/cache";
import { api } from "@/lib/server/api";
import { clientIp, getViewer } from "@/lib/server/viewer";

const KEY = /^[A-Za-z0-9_.:-]{8,128}$/;
const ACTIONS = ["approve", "reject", "dismiss", "hide_message", "warn"];
const CODES = ["scam", "stolen_photos", "wrong_info", "offensive", "discrimination", "spam", "other"];

export async function moderationDecideAction(itemId: number, action: string, note: string, code: string, key: string):
  Promise<{ ok: boolean; error?: string; effect?: string }> {
  const v = await getViewer();
  if (!v?.userId) return { ok: false, error: "UNAUTHENTICATED" };
  if (!Number.isInteger(itemId) || itemId < 1 || !ACTIONS.includes(action) || !KEY.test(key) || (code && !CODES.includes(code))) {
    return { ok: false, error: "VALIDATION_FAILED" };
  }
  const body: Record<string, string> = { action };
  if (note.trim()) body.note = note.trim().slice(0, 1000);
  if (code) body.code = code;
  const r = await api<{ effect: string }>("POST", `/v1/admin/moderation/${itemId}/decision`,
    { userId: v.userId, clientIp: await clientIp(), idempotencyKey: key, body });
  if (!r.ok) return { ok: false, error: r.error.code };
  revalidatePath("/[locale]/admin/moderation", "page");
  return { ok: true, effect: r.data.effect };
}

/** PUT /v1/admin/settings/{key} {value} (admins; the API checks the allowlist and the type, and logs the change). */
export async function adminSettingAction(key: string, value: unknown, idem: string): Promise<{ ok: boolean; error?: string; issue?: string }> {
  const v = await getViewer();
  if (!v?.userId) return { ok: false, error: "UNAUTHENTICATED" };
  if (!/^[a-z0-9_.]{3,60}$/.test(key) || !KEY.test(idem)) return { ok: false, error: "VALIDATION_FAILED" };
  const r = await api("PUT", `/v1/admin/settings/${key}`, { userId: v.userId, clientIp: await clientIp(), idempotencyKey: idem, body: { value } });
  if (!r.ok) return { ok: false, error: r.error.code, issue: (r.error.details as Array<{ issue?: string }> | undefined)?.[0]?.issue };
  revalidatePath("/[locale]/admin/settings", "page");
  return { ok: true };
}

/** PUT /v1/admin/users/{id}/role {role} (admins; not their own role; logged). */
export async function adminRoleAction(userId: string, role: string, idem: string): Promise<{ ok: boolean; error?: string }> {
  const v = await getViewer();
  if (!v?.userId) return { ok: false, error: "UNAUTHENTICATED" };
  if (!/^[0-9a-f-]{36}$/i.test(userId) || !["user", "owner", "moderator", "admin"].includes(role) || !KEY.test(idem)) return { ok: false, error: "VALIDATION_FAILED" };
  const r = await api("PUT", `/v1/admin/users/${userId}/role`, { userId: v.userId, clientIp: await clientIp(), idempotencyKey: idem, body: { role } });
  if (!r.ok) return { ok: false, error: r.error.code };
  revalidatePath("/[locale]/admin/users", "page");
  return { ok: true };
}
