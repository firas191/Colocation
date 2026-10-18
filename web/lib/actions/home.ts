"use server";
// Household pages (platform P5, P6): each action is one API call; balances, splits, reminders and permissions are
// computed by the API (SQL functions behind the row-level layer, D-104).
import { revalidatePath } from "next/cache";
import { api } from "@/lib/server/api";
import { clientIp, getViewer } from "@/lib/server/viewer";
import type { Detail } from "@/lib/errors";

const KEY = /^[A-Za-z0-9_.:-]{8,128}$/;
// households and their life (P5, P6); the flatmate profile and saved searches (P7)
const PATH = /^\/v1\/(households|household-invites|rent-payments|chore-assignments|issues|me\/flatmate-profile|me\/saved-searches)(\/[A-Za-z0-9-]+)*$/;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export interface HomeResult<T = any> { ok: boolean; data?: T; error?: string; details?: Detail[]; issue?: string }

/** One household API call; path limited to the household operations. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function homeAction<T = any>(method: "POST" | "PUT" | "PATCH" | "DELETE", path: string, body: unknown, key: string):
  Promise<HomeResult<T>> {
  const v = await getViewer();
  if (!v?.userId) return { ok: false, error: "UNAUTHENTICATED" };
  if (!KEY.test(key) || !PATH.test(path)) return { ok: false, error: "VALIDATION_FAILED" };
  const r = await api<T>(method, path, { userId: v.userId, clientIp: await clientIp(), idempotencyKey: key,
    body: method === "DELETE" ? undefined : (body ?? {}) });
  if (!r.ok) {
    const d = (r.error.details || []) as Detail[];
    return { ok: false, error: r.error.code, details: d, issue: d[0]?.issue };
  }
  revalidatePath("/", "layout");
  return { ok: true, data: r.data };
}
