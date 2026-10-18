"use server";
// Owner pages (platform P3): create a draft, upload photos, analyse, correct, publish, archive and publish again.
// Each action is one or two API calls; the API decides everything (what is missing, what may change, when a listing
// is published). The browser uploads the photo bytes itself, straight to the presigned URLs (PLATFORM_SPEC 6.2).
import { revalidatePath } from "next/cache";
import { api } from "@/lib/server/api";
import { clientIp, getViewer } from "@/lib/server/viewer";
import { redirect } from "@/i18n/navigation";
import { fieldErrors, type Detail } from "@/lib/errors";
import { POLICY_VERSION } from "@/lib/policy";
import { AMENITIES, RULES } from "@/lib/listing";

const KEY = /^[A-Za-z0-9_.:-]{8,128}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function caller() {
  const v = await getViewer();
  if (!v?.userId) return null;
  return { userId: v.userId, ip: await clientIp() };
}

export interface OwnerState { ok?: boolean; error?: string | null; fields?: Record<string, string>; details?: Detail[];
  savedAt?: string; changed?: string[] }

const firstIssue = (d: unknown) => ((d as Detail[] | undefined) || [])[0]?.issue;

/** /owner/new: POST /v1/listings with the owner's text, then the listing's page (photos next). */
export async function createListingAction(locale: string, _prev: OwnerState, form: FormData): Promise<OwnerState> {
  const c = await caller();
  if (!c) return { error: "UNAUTHENTICATED" };
  const key = String(form.get("idem") || "");
  if (!KEY.test(key)) return { error: "VALIDATION_FAILED" };
  const text = String(form.get("text") || "").trim();
  const jurisdiction = String(form.get("jurisdiction_code") || "");
  if (!text) return { error: "VALIDATION_FAILED", fields: { text: "required" } };
  const r = await api<{ listing_id: string }>("POST", "/v1/listings",
    { userId: c.userId, clientIp: c.ip, idempotencyKey: key, lang: locale, body: { text, jurisdiction_code: jurisdiction } });
  if (!r.ok) return { error: r.error.code, fields: fieldErrors(r.error.details as Detail[]) };
  revalidatePath("/", "layout");
  redirect({ href: `/owner/listings/${r.data.listing_id}`, locale });
  return { ok: true };
}

export interface Upload { upload_id: string; url: string; headers: Record<string, string>; content_type: string }

/** Presigned PUT URLs for the chosen files (POST .../media/presign). The browser then sends the bytes itself. */
export async function presignAction(listingId: string, files: Array<{ content_type: string; bytes: number }>, key: string):
  Promise<{ ok: boolean; uploads?: Upload[]; error?: string; purpose?: string; details?: Detail[] }> {
  const c = await caller();
  if (!c) return { ok: false, error: "UNAUTHENTICATED" };
  if (!UUID.test(listingId) || !KEY.test(key) || !Array.isArray(files) || files.length === 0 || files.length > 20) {
    return { ok: false, error: "VALIDATION_FAILED" };
  }
  const body = { files: files.map((f) => ({ kind: "photo", content_type: String(f.content_type), bytes: Number(f.bytes) })) };
  const r = await api<{ uploads: Upload[] }>("POST", `/v1/listings/${listingId}/media/presign`,
    { userId: c.userId, clientIp: c.ip, idempotencyKey: key, body });
  if (!r.ok) {
    const purpose = ((r.error.details || []) as Array<{ purpose?: string }>).map((d) => d.purpose).find(Boolean);
    return { ok: false, error: r.error.code, purpose, details: r.error.details as Detail[] };
  }
  return { ok: true, uploads: r.data.uploads };
}

/** The photo consent (media_processing), asked on the photo step when the owner did not give it at sign-up. */
export async function allowPhotosAction(locale: string, key: string): Promise<{ ok: boolean; error?: string }> {
  const c = await caller();
  if (!c) return { ok: false, error: "UNAUTHENTICATED" };
  if (!KEY.test(key)) return { ok: false, error: "VALIDATION_FAILED" };
  const r = await api("POST", "/v1/me/consents", { userId: c.userId, clientIp: c.ip, idempotencyKey: key, lang: locale,
    body: { consents: [{ purpose: "media_processing", granted: true }], policy_version: POLICY_VERSION, source: "web" } });
  return r.ok ? { ok: true } : { ok: false, error: r.error.code };
}

/** Starts the analysis job (photos, then the text). Returns the job id; the page follows it with jobStatusAction. */
export async function analyzeAction(listingId: string, key: string): Promise<{ ok: boolean; jobId?: string; error?: string; issue?: string }> {
  const c = await caller();
  if (!c) return { ok: false, error: "UNAUTHENTICATED" };
  if (!UUID.test(listingId) || !KEY.test(key)) return { ok: false, error: "VALIDATION_FAILED" };
  const r = await api<{ job_id: string }>("POST", `/v1/listings/${listingId}/analyze`, { userId: c.userId, clientIp: c.ip, idempotencyKey: key, body: {} });
  if (!r.ok) return { ok: false, error: r.error.code, issue: firstIssue(r.error.details) };
  return { ok: true, jobId: r.data.job_id };
}

export interface JobState { ok: boolean; status?: string; error?: string; output?: { processed?: number; rejected?: number } | null }

export async function jobStatusAction(jobId: string): Promise<JobState> {
  const c = await caller();
  if (!c) return { ok: false, error: "UNAUTHENTICATED" };
  if (!UUID.test(jobId)) return { ok: false, error: "VALIDATION_FAILED" };
  const r = await api<{ status: string; output?: JobState["output"] }>("GET", `/v1/jobs/${jobId}`, { userId: c.userId, clientIp: c.ip });
  if (!r.ok) return { ok: false, error: r.error.code };
  return { ok: true, status: r.data.status, output: r.data.output ?? null };
}

/** The review form: only the fields the owner changed go to PATCH /v1/listings/{id}, amounts in main units (the
 *  API converts and checks them, app.listing_change_check). The form sends the values it was shown in "was_*". */
export async function saveListingAction(locale: string, listingId: string, _prev: OwnerState, form: FormData): Promise<OwnerState> {
  const c = await caller();
  if (!c) return { error: "UNAUTHENTICATED" };
  const key = String(form.get("idem") || "");
  if (!UUID.test(listingId) || !KEY.test(key)) return { error: "VALIDATION_FAILED" };
  const s = (k: string) => String(form.get(k) ?? "").trim();
  const was = (k: string) => String(form.get(`was_${k}`) ?? "").trim();
  const body: Record<string, unknown> = {};
  const fields: Record<string, string> = {};
  const num = (k: string, integer: boolean) => {
    const v = s(k).replace(",", ".");
    if (v === was(k) || v === "") return;
    if (!(integer ? /^\d{1,4}$/ : /^\d{1,9}(\.\d{1,3})?$/).test(v)) { fields[k] = "type"; return; }
    body[k] = Number(v);
  };
  num("rent", false); num("deposit", false); num("bedrooms", true); num("min_stay_months", true);
  if (s("rent_period") && s("rent_period") !== was("rent_period")) body.rent_period = s("rent_period");
  for (const k of ["bills_included", "furnished"]) {
    const v = s(k);
    if (v !== was(k) && (v === "true" || v === "false")) body[k] = v === "true";
  }
  if (s("available_from") && s("available_from") !== was("available_from")) body.available_from = s("available_from");
  if (s("place") && s("place") !== was("place")) body.place = s("place");
  const before = new Set(was("amenities").split(",").filter(Boolean));
  const after = new Set(form.getAll("amenities").map(String).filter((a) => (AMENITIES as readonly string[]).includes(a)));
  const add = [...after].filter((a) => !before.has(a)), remove = [...before].filter((a) => !after.has(a));
  if (add.length) body.amenities_add = add;
  if (remove.length) body.amenities_remove = remove;
  const rules: Record<string, string> = {};
  for (const k of RULES) { const v = s(`rule_${k}`); if ((v === "yes" || v === "no") && v !== was(`rule_${k}`)) rules[k] = v; }
  if (Object.keys(rules).length) body.house_rules = rules;
  if (Object.keys(fields).length) return { error: "VALIDATION_FAILED", fields };
  if (Object.keys(body).length === 0) return { ok: true, changed: [], savedAt: new Date().toISOString() };
  const r = await api<{ diff: Array<{ field: string }> }>("PATCH", `/v1/listings/${listingId}`,
    { userId: c.userId, clientIp: c.ip, idempotencyKey: key, lang: locale, body });
  if (!r.ok) {
    const d = (r.error.details || []) as Detail[];
    // amenities_add/remove and house_rules errors belong to their fieldsets
    const f = fieldErrors(d.map((x) => ({ ...x, field: x.field?.startsWith("amenities") ? "amenities" : x.field })));
    return { error: r.error.code, fields: f, details: d };
  }
  revalidatePath(`/${locale}/owner/listings/${listingId}`);
  return { ok: true, changed: r.data.diff.map((x) => x.field), savedAt: new Date().toISOString() };
}

/** POST /v2/listings/{id}/submit (D-112). 422 details say what is missing, 409 that an analysis runs or the status.
 *  202: the trust check runs as a job (jobId), followed with trustCheckAction; 200: published without a check. */
export async function submitListingAction(locale: string, listingId: string, key: string):
  Promise<{ ok: boolean; jobId?: string; error?: string; details?: Detail[] }> {
  const c = await caller();
  if (!c) return { ok: false, error: "UNAUTHENTICATED" };
  if (!UUID.test(listingId) || !KEY.test(key)) return { ok: false, error: "VALIDATION_FAILED" };
  const r = await api<{ job_id?: string }>("POST", `/v2/listings/${listingId}/submit`,
    { userId: c.userId, clientIp: c.ip, idempotencyKey: key, lang: locale, body: {} });
  if (!r.ok) return { ok: false, error: r.error.code, details: r.error.details as Detail[] };
  if (r.status === 202 && r.data.job_id) return { ok: true, jobId: r.data.job_id };
  revalidatePath("/", "layout");
  return { ok: true };
}

export interface TrustCheckState {
  done: boolean;
  outcome?: "published" | "in_review" | "rejected" | "not_submitted" | "failed";
  signals?: string[];
  details?: Detail[];
}

/** The listing_trust job of a v2 submit: not done yet, or its outcome (docs/openapi.yaml, POST /v2/listings/{id}/submit). */
export async function trustCheckAction(jobId: string): Promise<TrustCheckState> {
  const c = await caller();
  if (!c || !UUID.test(jobId)) return { done: true, outcome: "failed" };
  const r = await api<{ status: string; output?: { outcome?: string; signals?: string[]; error?: { details?: Detail[] } } | null }>(
    "GET", `/v1/jobs/${jobId}`, { userId: c.userId, clientIp: c.ip });
  if (!r.ok) return r.status >= 500 ? { done: false } : { done: true, outcome: "failed" };
  if (r.data.status === "queued" || r.data.status === "running") return { done: false };
  const o = r.data.output || {};
  if (r.data.status !== "succeeded" || !o.outcome) return { done: true, outcome: "failed" };
  if (o.outcome === "published") revalidatePath("/", "layout");
  return { done: true, outcome: o.outcome as TrustCheckState["outcome"], signals: o.signals || [], details: o.error?.details || [] };
}

/** Archive (rented, withdrawn) or publish again: PATCH /v1/listings/{id} {status}. */
export async function setStatusAction(locale: string, listingId: string, status: "archived" | "published", key: string):
  Promise<{ ok: boolean; error?: string; issue?: string }> {
  const c = await caller();
  if (!c) return { ok: false, error: "UNAUTHENTICATED" };
  if (!UUID.test(listingId) || !KEY.test(key) || !["archived", "published"].includes(status)) return { ok: false, error: "VALIDATION_FAILED" };
  const r = await api("PATCH", `/v1/listings/${listingId}`, { userId: c.userId, clientIp: c.ip, idempotencyKey: key, lang: locale, body: { status } });
  if (!r.ok) return { ok: false, error: r.error.code, issue: firstIssue(r.error.details) };
  revalidatePath("/", "layout");
  return { ok: true };
}
