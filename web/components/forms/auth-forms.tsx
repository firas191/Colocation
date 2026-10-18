"use client";
import { useActionState } from "react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { Field, Input, Notice } from "@/components/ui/field";
import { Link } from "@/i18n/navigation";
import {
  signUpAction, signInAction, resendVerificationAction, requestResetAction, resetPasswordAction, type FormState,
} from "@/lib/actions/auth";

function useAuthError() {
  const t = useTranslations("auth.errors");
  return (code?: string | null) => (code ? (t.has(code) ? t(code) : t("UNKNOWN")) : null);
}

export function SignUpForm({ locale }: { locale: string }) {
  const t = useTranslations("auth.signup");
  const err = useAuthError();
  const [state, action, pending] = useActionState<FormState, FormData>(signUpAction.bind(null, locale), {});
  return (
    <form action={action} className="flex flex-col gap-5" noValidate={false}>
      {state.error && <Notice tone="error">{err(state.error)}</Notice>}
      <Field id="name" label={t("name")}><Input id="name" name="name" autoComplete="nickname" maxLength={100} /></Field>
      <Field id="email" label={t("email")}><Input id="email" name="email" type="email" required autoComplete="email" dir="ltr" /></Field>
      <Field id="password" label={t("password")} hint={t("passwordHint")}>
        <Input id="password" name="password" type="password" required minLength={10} maxLength={128} autoComplete="new-password"
          aria-describedby="password-hint" />
      </Field>
      <Button type="submit" disabled={pending} className="w-full">{t("submit")}</Button>
      <p className="text-ink-soft">{t("haveAccount")} <Link href="/login" className="font-semibold">{t("signIn")}</Link></p>
    </form>
  );
}

export function LoginForm({ locale }: { locale: string }) {
  const t = useTranslations("auth.login");
  const s = useTranslations("auth.signup");
  const err = useAuthError();
  const [state, action, pending] = useActionState<FormState, FormData>(signInAction.bind(null, locale), {});
  return (
    <form action={action} className="flex flex-col gap-5">
      {state.error && <Notice tone="error">{err(state.error)}</Notice>}
      <Field id="email" label={s("email")}><Input id="email" name="email" type="email" required autoComplete="email" dir="ltr" /></Field>
      <Field id="password" label={s("password")}>
        <Input id="password" name="password" type="password" required autoComplete="current-password" />
      </Field>
      <Button type="submit" disabled={pending} className="w-full">{t("submit")}</Button>
      <div className="flex flex-wrap justify-between gap-3 text-ink-soft">
        <span>{t("noAccount")} <Link href="/signup" className="font-semibold">{t("signUp")}</Link></span>
        <Link href="/reset" className="link-action">{t("forgot")}</Link>
      </div>
    </form>
  );
}

export function ResendForm({ locale, email }: { locale: string; email: string }) {
  const t = useTranslations("auth.verify");
  const s = useTranslations("auth.signup");
  const err = useAuthError();
  const [state, action, pending] = useActionState<FormState, FormData>(resendVerificationAction.bind(null, locale), {});
  return (
    <form action={action} className="flex flex-col gap-4">
      {state.done && <Notice tone="ok">{t("resent")}</Notice>}
      {state.error && <Notice tone="error">{err(state.error)}</Notice>}
      {email ? <input type="hidden" name="email" value={email} /> : (
        <Field id="email" label={s("email")}><Input id="email" name="email" type="email" required autoComplete="email" dir="ltr" /></Field>
      )}
      <div className="flex flex-wrap items-center gap-5">
        <Button type="submit" variant="secondary" disabled={pending}>{t("resend")}</Button>
        <Link href="/login" className="link-back">{t("back")}</Link>
      </div>
    </form>
  );
}

export function ResetRequestForm({ locale }: { locale: string }) {
  const t = useTranslations("auth.reset");
  const s = useTranslations("auth.signup");
  const err = useAuthError();
  const [state, action, pending] = useActionState<FormState, FormData>(requestResetAction.bind(null, locale), {});
  return (
    <form action={action} className="flex flex-col gap-5">
      {state.done && <Notice tone="ok">{t("sent")}</Notice>}
      {state.error && <Notice tone="error">{err(state.error)}</Notice>}
      <Field id="email" label={s("email")}><Input id="email" name="email" type="email" required autoComplete="email" dir="ltr" /></Field>
      <Button type="submit" disabled={pending} className="w-full">{t("submit")}</Button>
    </form>
  );
}

export function ResetForm({ locale, token }: { locale: string; token: string }) {
  const t = useTranslations("auth.reset");
  const s = useTranslations("auth.signup");
  const l = useTranslations("auth.login");
  const err = useAuthError();
  const [state, action, pending] = useActionState<FormState, FormData>(resetPasswordAction.bind(null, locale), {});
  if (state.done) return <Notice tone="ok">{t("done")} <Link href="/login">{l("submit")}</Link></Notice>;
  return (
    <form action={action} className="flex flex-col gap-5">
      {state.error && <Notice tone="error">{err(state.error)}</Notice>}
      <input type="hidden" name="token" value={token} />
      <Field id="password" label={s("password")} hint={s("passwordHint")}>
        <Input id="password" name="password" type="password" required minLength={10} maxLength={128} autoComplete="new-password"
          aria-describedby="password-hint" />
      </Field>
      <Button type="submit" disabled={pending}>{t("newSubmit")}</Button>
    </form>
  );
}
