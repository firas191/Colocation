"use server";
// Messages, visits, applications, blocks and reports (platform P4). Each action is one API call; the API decides who
// may do what (row-level layer, D-103) and says so with codes the pages turn into sentences.
import { revalidatePath } from "next/cache";
import { api } from "@/lib/server/api";
import { clientIp, getViewer } from "@/lib/server/viewer";
import type { Detail } from "@/lib/errors";

const KEY = /^[A-Za-z0-9_.:-]{8,128}$/;
const ID = /^[0-9a-f-]{36}$/i;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export interface Result<T = any> { ok: boolean; data?: T; error?: string; details?: Detail[]; issue?: string }

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function call<T = any>(method: string, path: string, key: string, body?: unknown, refresh: string[] = []): Promise<Result<T>> {
  const v = await getViewer();
  if (!v?.userId) return { ok: false, error: "UNAUTHENTICATED" };
  if (!KEY.test(key)) return { ok: false, error: "VALIDATION_FAILED" };
  const r = await api<T>(method, path, { userId: v.userId, clientIp: await clientIp(), idempotencyKey: key, body });
  if (!r.ok) {
    const d = (r.error.details || []) as Detail[];
    return { ok: false, error: r.error.code, details: d, issue: d[0]?.issue };
  }
  for (const p of refresh) revalidatePath(p, "page");
  revalidatePath("/", "layout");                 // the header's counts
  return { ok: true, data: r.data };
}

export async function startConversationAction(listingId: string, text: string, key: string) {
  if (!ID.test(listingId)) return { ok: false, error: "VALIDATION_FAILED" } as Result<{ conversation: { conversation_id: string } }>;
  return call<{ conversation: { conversation_id: string } }>("POST", "/v1/conversations", key, { listing_id: listingId, text: text.trim() });
}

export async function sendMessageAction(conversationId: string, text: string, key: string) {
  if (!ID.test(conversationId)) return { ok: false, error: "VALIDATION_FAILED" } as Result;
  return call("POST", `/v1/conversations/${conversationId}/messages`, key, { text: text.trim() }, ["/[locale]/messages/[id]"]);
}

export async function blockAction(userId: string, on: boolean, key: string) {
  if (!ID.test(userId)) return { ok: false, error: "VALIDATION_FAILED" } as Result;
  return on ? call("POST", "/v1/me/blocks", key, { user_id: userId }) : call("DELETE", `/v1/me/blocks/${userId}`, key);
}

export async function requestVisitAction(slotId: string, note: string, key: string) {
  if (!ID.test(slotId)) return { ok: false, error: "VALIDATION_FAILED" } as Result;
  return call("POST", "/v1/visits", key, note.trim() ? { slot_id: slotId, note: note.trim() } : { slot_id: slotId }, ["/[locale]/visits"]);
}

export async function decideVisitAction(visitId: string, action: string, startsAt: string | null, key: string) {
  if (!ID.test(visitId)) return { ok: false, error: "VALIDATION_FAILED" } as Result;
  return call("POST", `/v1/visits/${visitId}/decision`, key, startsAt ? { action, starts_at: startsAt } : { action }, ["/[locale]/visits"]);
}

export async function saveSlotsAction(listingId: string, slots: Array<{ starts_at: string; ends_at: string; capacity: number }>, key: string) {
  if (!ID.test(listingId)) return { ok: false, error: "VALIDATION_FAILED" } as Result;
  return call("PUT", `/v1/listings/${listingId}/visit-slots`, key, { slots });
}

export async function applyAction(listingId: string, message: string, moveIn: string, share: boolean, key: string) {
  if (!ID.test(listingId)) return { ok: false, error: "VALIDATION_FAILED" } as Result;
  const body: Record<string, unknown> = { share_profile: share };
  if (message.trim()) body.message = message.trim();
  if (moveIn) body.move_in_from = moveIn;
  return call("POST", `/v1/listings/${listingId}/applications`, key, body, ["/[locale]/applications"]);
}

export async function decideApplicationAction(id: string, action: "accept" | "decline" | "withdraw", key: string) {
  if (!ID.test(id)) return { ok: false, error: "VALIDATION_FAILED" } as Result;
  return action === "withdraw"
    ? call("POST", `/v1/applications/${id}/withdraw`, key, {}, ["/[locale]/applications"])
    : call("POST", `/v1/applications/${id}/decision`, key, { action }, ["/[locale]/applications"]);
}

export async function reportAction(targetType: "listing" | "user" | "message", targetId: string, reason: string, detail: string, key: string) {
  const body: Record<string, unknown> = { target_type: targetType, target_id: String(targetId), reason };
  if (detail.trim()) body.detail = detail.trim().slice(0, 1000);
  return call("POST", "/v1/reports", key, body);
}
