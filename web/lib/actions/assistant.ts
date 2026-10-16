"use server";
// The assistant page (platform P2). One message: POST /v1/assistant/message (the orchestrator and its agents, D-084,
// D-087, D-088), then, for search results, GET /v2/search with their ids to show the same cards as the search page
// (cover photo, favourite). Confirm and Cancel of an owner proposal: PATCH /v1/listings/{id} with change_id, and
// POST /v1/listing-changes/{id}/cancel. The conversation is not stored by the website (D-062).
import { api } from "@/lib/server/api";
import { clientIp, getViewer } from "@/lib/server/viewer";
import type { ListingCard } from "@/lib/listing";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KEY = /^[A-Za-z0-9_.:-]{8,128}$/;

export interface Citation { n: number; title: string | null; cite_as?: string | null; url: string | null; source_type: string | null;
  article?: string | null; retrieved_at?: string | null }
export interface Change { field: string; before?: unknown; after?: unknown; currency?: string }
export interface Reply {
  ok: boolean; error?: string; intent?: string | null; status?: string; answer?: string | null; clarifying_question?: string | null;
  results?: ListingCard[]; count?: number; jurisdiction?: string | null; warnings?: string[];
  abstained?: boolean; conflict?: boolean; citations?: Citation[]; notice_version?: string | null;
  proposal?: { change_id: string; listing_id: string; listing_number?: number | null; diff: Change[]; expires_at?: string } | null;
}

export async function sendMessageAction(locale: string, text: string): Promise<Reply> {
  const v = await getViewer();
  if (!v?.userId) return { ok: false, error: "UNAUTHENTICATED" };
  const body = text.trim().slice(0, 2000);
  if (!body) return { ok: false, error: "VALIDATION_FAILED" };
  const ip = await clientIp();
  // agents answer in 25 to 82 s on the owner's PC (T-51, T-60, T-61): wait well beyond the API's model timeout
  const r = await api<Reply & { results?: Array<{ id: string }>; applied?: { jurisdiction?: string } | null }>("POST", "/v1/assistant/message",
    { userId: v.userId, clientIp: ip, lang: locale, body: { text: body }, timeoutMs: 240_000 });
  if (!r.ok) return { ok: false, error: r.error.code };
  const d = r.data;
  let results: ListingCard[] | undefined;
  const ids = (d.results || []).map((x) => x.id).slice(0, 50);
  const jur = d.applied?.jurisdiction || d.jurisdiction || null;
  if (ids.length && jur) {
    const cards = await api<{ results: ListingCard[] }>("GET", "/v2/search", { userId: v.userId, clientIp: ip, lang: locale,
      query: { jurisdiction: jur, ids: ids.join(","), limit: "50" } });
    results = cards.ok ? cards.data.results : (d.results as ListingCard[]);
  }
  return { ok: true, intent: d.intent, status: d.status, answer: d.answer ?? null, clarifying_question: d.clarifying_question ?? null,
    results, count: d.count, jurisdiction: jur, warnings: d.warnings || [], abstained: d.abstained, conflict: d.conflict,
    citations: d.citations || [], notice_version: d.notice_version ?? null, proposal: d.proposal ?? null };
}

export async function decideChangeAction(decision: "confirm" | "cancel", listingId: string, changeId: string, key: string):
  Promise<{ ok: boolean; error?: string; issue?: string; status?: string; diff?: Change[] }> {
  const v = await getViewer();
  if (!v?.userId) return { ok: false, error: "UNAUTHENTICATED" };
  if (!UUID.test(listingId) || !UUID.test(changeId) || !KEY.test(key)) return { ok: false, error: "VALIDATION_FAILED" };
  const o = { userId: v.userId, clientIp: await clientIp(), idempotencyKey: key };
  const r = decision === "confirm"
    ? await api<{ status: string; diff: Change[] }>("PATCH", `/v1/listings/${listingId}`, { ...o, body: { change_id: changeId } })
    : await api<{ status: string }>("POST", `/v1/listing-changes/${changeId}/cancel`, { ...o, body: {} });
  if (!r.ok) {
    const issue = (r.error.details as Array<{ issue?: string }>)[0]?.issue;
    return { ok: false, error: r.error.code, issue };
  }
  return { ok: true, status: r.data.status, diff: (r.data as { diff?: Change[] }).diff };
}
