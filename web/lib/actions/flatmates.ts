"use server";
// Flatmate matching (platform P12, D-115, from Yosr's roommate matching): contact requests that both must agree to, the
// sentence for a match, the profile agent and saving what the person confirmed. Each action is one API call.
import { revalidatePath } from "next/cache";
import { api } from "@/lib/server/api";
import { clientIp, getViewer } from "@/lib/server/viewer";
import type { Detail } from "@/lib/errors";

const KEY = /^[A-Za-z0-9_.:-]{8,128}$/;
const ID = /^[0-9a-f-]{36}$/i;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export interface FlatmateResult<T = any> { ok: boolean; data?: T; error?: string; details?: Detail[]; issue?: string }

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function post<T = any>(path: string, body: unknown, key: string, refresh = true): Promise<FlatmateResult<T>> {
  const v = await getViewer();
  if (!v?.userId) return { ok: false, error: "UNAUTHENTICATED" };
  if (!KEY.test(key)) return { ok: false, error: "VALIDATION_FAILED" };
  const r = await api<T>("POST", path, { userId: v.userId, clientIp: await clientIp(), idempotencyKey: key, body });
  if (!r.ok) {
    const d = (r.error.details || []) as Detail[];
    return { ok: false, error: r.error.code, details: d, issue: d[0]?.issue };
  }
  if (refresh) revalidatePath("/", "layout");
  return { ok: true, data: r.data };
}

export async function contactRequestAction(userId: string, note: string, key: string) {
  if (!ID.test(userId)) return { ok: false, error: "VALIDATION_FAILED" } as FlatmateResult;
  return post(`/v1/flatmates/${userId}/contact-requests`, note.trim() ? { note: note.trim().slice(0, 500) } : {}, key);
}

export async function decideContactRequestAction(id: string, action: "accept" | "refuse" | "cancel", key: string) {
  if (!ID.test(id)) return { ok: false, error: "VALIDATION_FAILED" } as FlatmateResult<{ conversation_id: string | null }>;
  return post<{ conversation_id: string | null }>(`/v1/contact-requests/${id}/decision`, { action }, key);
}

export interface Explanation { score: number | null; sentence: string; source: "model" | "code" }

export async function explainAction(userId: string, language: string, key: string) {
  if (!ID.test(userId)) return { ok: false, error: "VALIDATION_FAILED" } as FlatmateResult<Explanation>;
  return post<Explanation>(`/v1/flatmates/${userId}/explanation`, { language: ["fr", "en", "ar"].includes(language) ? language : "fr" }, key, false);
}

export interface Proposal { lifestyle?: Record<string, string>; budget_min?: number; budget_max?: number; areas?: string[];
  move_in_from?: string; headline?: string; seeking?: string; languages?: string[]; visible?: boolean }

export async function profileAssistantAction(text: string, key: string) {
  return post<{ answer: string; proposal: Proposal | null; dropped: { field: string; value?: string; why: string }[] }>(
    "/v1/me/flatmate-profile/assistant", { text: text.trim().slice(0, 2000) }, key, false);
}

export async function applyProposalAction(p: Proposal, key: string) {
  return post("/v1/me/flatmate-profile/apply", p, key);
}
