"use server";
// Account actions. They run on the website server: Better Auth for the session, then the platform user.
import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { APIError } from "better-auth/api";
import { redirect } from "@/i18n/navigation";
import { auth } from "@/lib/server/auth";
import { api } from "@/lib/server/api";
import { syncPlatformUser, clientIp } from "@/lib/server/viewer";

export interface FormState { error?: string | null; done?: boolean; email?: string }
const LOCALES = ["fr", "en", "ar"];
const loc = (x: string) => (LOCALES.includes(x) ? x : "fr");
const str = (f: FormData, k: string) => String(f.get(k) ?? "").trim();

function code(e: unknown): string {
  if (e instanceof APIError) {
    const c = (e.body as { code?: string } | undefined)?.code;
    if (e.status === "TOO_MANY_REQUESTS" || e.statusCode === 429) return "TOO_MANY_REQUESTS";
    if (c) return c.replace(/^INVALID_PASSWORD$/, "INVALID_EMAIL_OR_PASSWORD");
  }
  return "UNKNOWN";
}

export async function signUpAction(locale: string, _prev: FormState, form: FormData): Promise<FormState> {
  const l = loc(locale);
  const email = str(form, "email").toLowerCase();
  try {
    await auth.api.signUpEmail({
      body: { name: str(form, "name") || email.split("@")[0], email, password: String(form.get("password") ?? ""), locale: l,
              callbackURL: `/${l}/consent` },
      headers: await headers(),
    });
  } catch (e) {
    return { error: code(e) };
  }
  redirect({ href: { pathname: "/verify", query: { email } }, locale: l });
  return {};
}

export async function signInAction(locale: string, _prev: FormState, form: FormData): Promise<FormState> {
  const l = loc(locale);
  let user;
  try {
    const r = await auth.api.signInEmail({
      body: { email: str(form, "email").toLowerCase(), password: String(form.get("password") ?? ""), callbackURL: `/${l}/profile` },
      headers: await headers(),
    });
    user = r.user;
  } catch (e) {
    return { error: code(e) };
  }
  // Keep the platform user up to date (e-mail, language). If the API is down the session still exists;
  // the pages say the platform is unavailable and sync again on the next request.
  const id = await syncPlatformUser(user as never, l);
  if (!id) return { error: "PLATFORM_UNAVAILABLE" };
  const me = await api<{ consent_required: string[] }>("GET", "/v1/me", { userId: id, clientIp: await clientIp() });
  revalidatePath("/", "layout");
  redirect({ href: me.ok && me.data.consent_required.length === 0 ? "/profile" : "/consent", locale: l });
  return {};
}

export async function resendVerificationAction(locale: string, _prev: FormState, form: FormData): Promise<FormState> {
  const l = loc(locale);
  try {
    await auth.api.sendVerificationEmail({ body: { email: str(form, "email").toLowerCase(), callbackURL: `/${l}/consent` } });
  } catch (e) {
    if (code(e) === "TOO_MANY_REQUESTS") return { error: "TOO_MANY_REQUESTS" };
  }
  return { done: true };      // same answer whether the address exists or not
}

export async function requestResetAction(locale: string, _prev: FormState, form: FormData): Promise<FormState> {
  const l = loc(locale);
  try {
    await auth.api.requestPasswordReset({ body: { email: str(form, "email").toLowerCase(), redirectTo: `/${l}/reset/new` } });
  } catch (e) {
    if (code(e) === "TOO_MANY_REQUESTS") return { error: "TOO_MANY_REQUESTS" };
  }
  return { done: true };      // never says whether an account exists
}

export async function resetPasswordAction(locale: string, _prev: FormState, form: FormData): Promise<FormState> {
  try {
    await auth.api.resetPassword({ body: { newPassword: String(form.get("password") ?? ""), token: str(form, "token") } });
  } catch (e) {
    const c = code(e);
    return { error: c === "UNKNOWN" ? "INVALID_TOKEN" : c };
  }
  return { done: true };
}

export async function signOutAction(locale: string) {
  await auth.api.signOut({ headers: await headers() });
  revalidatePath("/", "layout");
  redirect({ href: "/", locale: loc(locale) });
}
