"use server";
// Favourites (PUT and DELETE /v1/me/favourites/{listing_id}). Both are idempotent in the API; the key the button
// generated per press also makes a double click return the stored answer.
import { revalidatePath } from "next/cache";
import { api } from "@/lib/server/api";
import { clientIp, getViewer } from "@/lib/server/viewer";

const KEY = /^[A-Za-z0-9_.:-]{8,128}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function setFavouriteAction(listingId: string, on: boolean, key: string): Promise<{ ok: boolean; favourite?: boolean; error?: string }> {
  const v = await getViewer();
  if (!v?.userId) return { ok: false, error: "UNAUTHENTICATED" };
  if (!UUID.test(listingId) || !KEY.test(key)) return { ok: false, error: "VALIDATION_FAILED" };
  const r = await api<{ favourite: boolean }>(on ? "PUT" : "DELETE", `/v1/me/favourites/${listingId}`,
    { userId: v.userId, clientIp: await clientIp(), idempotencyKey: key, body: on ? {} : undefined });
  if (!r.ok) return { ok: false, error: r.error.code };
  revalidatePath("/[locale]/favourites", "page");
  return { ok: true, favourite: r.data.favourite };
}
