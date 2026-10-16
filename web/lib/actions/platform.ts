"use server";
// Actions that change platform data. Each passes the idempotency key the page generated when it was shown, so a
// double submit or a retry returns the stored answer (docs/API_SIGNING.md).
import { revalidatePath } from "next/cache";
import { api } from "@/lib/server/api";
import { clientIp, getViewer } from "@/lib/server/viewer";
import { redirect } from "@/i18n/navigation";
import { fieldErrors, type Detail } from "@/lib/errors";
import { POLICY_VERSION } from "@/lib/policy";

const KEY = /^[A-Za-z0-9_.:-]{8,128}$/;

async function caller() {
  const v = await getViewer();
  if (!v?.userId) return null;
  return { userId: v.userId, ip: await clientIp() };
}

export interface ActionState { ok?: boolean; error?: string | null; fields?: Record<string, string>; warnings?: string[];
  profile?: Record<string, unknown> | null; savedAt?: string; version?: number }

export async function consentAction(locale: string, _prev: ActionState, form: FormData): Promise<ActionState> {
  const c = await caller();
  if (!c) return { error: "UNAUTHENTICATED" };
  if (!form.get("terms") || !form.get("privacy") || !form.get("adult")) return { error: "consent_required" };
  const key = String(form.get("idem") || "");
  if (!KEY.test(key)) return { error: "VALIDATION_FAILED" };
  const r = await api("POST", "/v1/me/consents", {
    userId: c.userId, clientIp: c.ip, idempotencyKey: key, lang: locale,
    body: { consents: [{ purpose: "terms", granted: true }, { purpose: "privacy", granted: true },
                       { purpose: "media_processing", granted: !!form.get("media") }],
            policy_version: POLICY_VERSION, source: "web" },
  });
  if (!r.ok) return { error: r.error.code };
  revalidatePath("/", "layout");            // the header shows the member links from now on
  redirect({ href: "/profile", locale });
  return { ok: true };
}

const PREFS = ["smoking", "pets", "guests", "quiet_hours", "schedule", "cleanliness"] as const;

/** The form's main-unit amount to minor units with the exponent the API gave for the currency (Money.exponent). */
function minor(v: FormDataEntryValue | null, exponent: number): number | null {
  const s = String(v ?? "").trim().replace(",", ".");
  if (!s) return null;
  if (!/^\d{1,9}(\.\d{1,4})?$/.test(s)) return NaN;
  return Math.round(Number(s) * 10 ** exponent);
}

export async function saveProfileAction(locale: string, _prev: ActionState, form: FormData): Promise<ActionState> {
  const c = await caller();
  if (!c) return { error: "UNAUTHENTICATED" };
  const key = String(form.get("idem") || "");
  if (!KEY.test(key)) return { error: "VALIDATION_FAILED" };
  const jurisdiction = String(form.get("jurisdiction_code") || "");
  const exponent = Number(form.get("exponent") ?? 2);
  const currency = String(form.get("currency") || "") || null;
  const bmin = minor(form.get("budget_min"), exponent), bmax = minor(form.get("budget_max"), exponent);
  const fields: Record<string, string> = {};
  if (Number.isNaN(bmin)) fields.budget_min_minor = "type";
  if (Number.isNaN(bmax)) fields.budget_max_minor = "type";
  if (Object.keys(fields).length) return { error: "VALIDATION_FAILED", fields };
  const prefs: Record<string, string> = {};
  for (const p of PREFS) { const v = String(form.get(p) || ""); if (v && v !== "unset") prefs[p] = v; }
  const stay = String(form.get("min_stay_months") || "").trim();
  const body = {
    jurisdiction_code: jurisdiction,
    budget_min_minor: bmin, budget_max_minor: bmax,
    currency: bmin !== null || bmax !== null ? currency : null,
    budget_period: bmin !== null || bmax !== null ? String(form.get("budget_period") || "month") : null,
    anchor_label: String(form.get("anchor_label") || "").trim() || null,
    move_in_from: String(form.get("move_in_from") || "") || null,
    min_stay_months: stay ? Number(stay) : null,
    declared_preferences: prefs,
    languages: form.getAll("languages").map(String),
  };
  const r = await api<{ profile_version: number; anchor_geocode?: { status?: string } | null }>("PUT", "/v1/profiles/me",
    { userId: c.userId, clientIp: c.ip, idempotencyKey: key, lang: locale, body });
  if (!r.ok) return { error: r.error.code, fields: fieldErrors(r.error.details as Detail[]) };
  revalidatePath(`/${locale}/profile`);
  const geo = r.data.anchor_geocode?.status;
  return { ok: true, version: r.data.profile_version, warnings: geo && geo !== "found" ? [`anchor_${geo}`] : [] };
}

/** POST /v1/profiles/extract (prompt P2, local model): a sentence to form values, not saved. */
export async function extractProfileAction(locale: string, _prev: ActionState, form: FormData): Promise<ActionState> {
  const c = await caller();
  if (!c) return { error: "UNAUTHENTICATED" };
  const text = String(form.get("text") || "").trim().slice(0, 2000);
  if (!text) return { error: "VALIDATION_FAILED" };
  const jurisdiction = String(form.get("jurisdiction_code") || "") || undefined;
  const r = await api<{ profile: Record<string, unknown>; warnings: string[] }>("POST", "/v1/profiles/extract",
    { userId: c.userId, clientIp: c.ip, lang: locale, body: { text, jurisdiction, save: false }, timeoutMs: 180_000 });
  if (!r.ok) return { error: r.error.code };
  return { ok: true, profile: r.data.profile, warnings: r.data.warnings };
}

export async function markAllReadAction(locale: string, form: FormData) {
  const c = await caller();
  if (!c) return;
  const key = String(form.get("idem") || "");
  if (!KEY.test(key)) return;
  await api("POST", "/v1/me/notifications/read", { userId: c.userId, clientIp: c.ip, idempotencyKey: key, body: { all: true } });
  revalidatePath("/", "layout");            // page and the unread count in the header
}
