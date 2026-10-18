"use client";
// A small form for one household API call: the page gives a function that turns the fields into the body
// (input shape only; the API checks everything).
import { useState, useTransition, type ReactNode } from "react";
import { useTranslations } from "next-intl";
import { useRouter } from "@/i18n/navigation";
import { Button } from "@/components/ui/button";
import { Notice } from "@/components/ui/field";
import { homeAction, type HomeResult } from "@/lib/actions/home";

export type BodyFrom = "household" | "join" | "announcement" | "settlement" | "rent" | "chore" | "shopping" | "event" | "issue" | "issueUpdate"
  | "flatmateProfile" | "roomPost" | "savedSearch" | "docInventory" | "docAgreement" | "docReceipt" | "docRules" | "docLivingPlan"
  | "moveOut" | "deposit";

function rows(text: string, cols: string[]) {
  const out = text.split("\n").map((l) => l.split("|").map((c) => c.trim())).filter((c) => c.some(Boolean)).slice(0, 80)
    .map((c) => Object.fromEntries(cols.map((k, i) => [k, c[i] || ""])));
  return out.length ? out : "";
}

/** form fields -> API body. Amounts typed in main units become minor units with the household's exponent. */
function toBody(kind: BodyFrom, f: FormData, exponent: number): unknown {
  const s = (k: string) => String(f.get(k) ?? "").trim();
  const minor = (k: string) => { const v = s(k).replace(",", "."); return /^\d{1,9}(\.\d{1,3})?$/.test(v) ? Math.round(Number(v) * 10 ** exponent) : null; };
  const opt = (o: Record<string, unknown>) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== "" && v !== null && v !== undefined));
  switch (kind) {
    case "household": return opt({ name: s("name"), jurisdiction_code: s("jurisdiction_code"), role: s("role") || undefined });
    case "join": return { code: s("code") };
    case "announcement": return { body: s("body"), pinned: !!f.get("pinned") };
    case "settlement": return opt({ to_user: s("to_user"), amount_minor: minor("amount") });
    case "rent": return opt({ period: s("period"), amount_minor: minor("amount"), paid_on: s("paid_on") });
    case "chore": return opt({ title: s("title"), frequency: s("frequency"), next_due_on: s("next_due_on") });
    case "shopping": return opt({ label: s("label"), quantity: s("quantity") });
    case "event": return opt({ title: s("title"), starts_at: s("starts_at") ? new Date(s("starts_at")).toISOString() : "",
      ends_at: s("ends_at") ? new Date(s("ends_at")).toISOString() : "", all_day: !!f.get("all_day") });
    case "issue": return opt({ title: s("title"), description: s("description"), category: s("category"), urgency: s("urgency") });
    case "issueUpdate": return opt({ status: s("status"), comment: s("comment") });
    // platform P7 (D-106)
    case "flatmateProfile": return opt({ visible: !!f.get("visible"), headline: s("headline"), bio: s("bio"), seeking: s("seeking"),
      areas: s("areas") ? s("areas").split(",").map((x) => x.trim()).filter(Boolean).slice(0, 5) : [], move_in_from: s("move_in_from") });
    case "roomPost": return opt({ title: s("title") });
    // platform P9 (D-108): table rows are typed one per line, cells separated by "|"
    case "docInventory": return { kind: s("kind"), language: s("language"), values: opt({ date: s("date"),
      items: rows(s("items"), ["room", "item", "condition", "notes"]) }) };
    case "docAgreement": return { kind: "flatmate_agreement", language: s("language"), values: opt({ start_date: s("start_date"),
      notice_days: s("notice_days") ? Number(s("notice_days")) : "", shares: rows(s("shares"), ["name", "share"]), address: s("address") }) };
    case "docReceipt": return { kind: "rent_receipt", language: s("language"), payment_id: s("payment_id") };
    case "docRules": return { kind: "house_rules", language: s("language") };
    // platform P12 (D-115): the household gives the rest (habits, costs, chores, rules)
    case "docLivingPlan": return { kind: "living_plan", language: s("language"), values: opt({ start_date: s("start_date"), notes: s("notes") }) };
    // platform P10 (D-109)
    case "moveOut": return { planned_on: s("planned_on") };
    case "deposit": {
      const ded = rows(s("deductions"), ["reason", "amount"]);
      return opt({ amount_minor: minor("amount"), paid_on: s("paid_on"), held_by: s("held_by"), returned_minor: s("returned") ? minor("returned") : "",
        returned_on: s("returned_on"), deductions: Array.isArray(ded) ? ded.map((d) => {
          const v = String(d.amount).replace(",", ".");
          return { reason: d.reason, amount_minor: /^\d{1,9}(\.\d{1,3})?$/.test(v) ? Math.round(Number(v) * 10 ** exponent) : -1 };
        }) : [] });
    }
    case "savedSearch": {
      let query: unknown = {};
      try { query = JSON.parse(s("query") || "{}"); } catch { query = {}; }
      return { name: s("name"), query, alert: f.get("alert") ? "daily" : "none" };
    }
  }
}

function fill(pattern: string, r: HomeResult): string | null {
  let missing = false;
  const out = pattern.replace(/\{(\w+)\}/g, (_, k: string) => {
    const v = (r.data as Record<string, unknown> | undefined)?.[k];
    if (typeof v !== "string" || !/^[A-Za-z0-9-]+$/.test(v)) { missing = true; return ""; }
    return v;
  });
  return missing ? null : out;
}

export function FormAction({ method = "POST", path, kind, exponent = 3, children, submit, done, then, resetOnDone = true }:
  { method?: "POST" | "PUT" | "PATCH"; path: string; kind: BodyFrom; exponent?: number; children: ReactNode; submit: string; done?: string;
    then?: string; resetOnDone?: boolean }) {
  const t = useTranslations("home");
  const e = useTranslations("errors");
  const router = useRouter();
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<null | { tone: "ok" | "error"; text: string }>(null);
  return (
    <form className="flex flex-col gap-3" onSubmit={(ev) => {
      ev.preventDefault();
      const form = ev.currentTarget;
      const body = toBody(kind, new FormData(form), exponent);
      start(async () => {
        const r = await homeAction(method, path, body, `form-${crypto.randomUUID()}`);
        if (r.ok) {
          setMsg(done ? { tone: "ok", text: done } : null);
          if (resetOnDone) form.reset();
          // then: a path with {field} taken from the answer's data, e.g. "/households/{household_id}" (a string, not a
          // function: a server page cannot hand a function to this client component, F-078)
          const next = then ? fill(then, r) : null;
          if (next) router.push(next); else router.refresh();
        } else {
          setMsg({ tone: "error", text: r.issue && t.has(`issues.${r.issue}`) ? t(`issues.${r.issue}`) : (r.error && e.has(r.error) ? e(r.error) : t("failed")) });
        }
      });
    }}>
      {children}
      <Button type="submit" disabled={pending} className="self-start">{submit}</Button>
      {msg && <Notice tone={msg.tone}>{msg.text}</Notice>}
    </form>
  );
}
