// Account e-mails (address check, password reset). SMTP_*: Mailpit in development (docker compose), a real mail
// account later. The text comes from messages/<locale>.json like the pages.
import "server-only";
import nodemailer from "nodemailer";
import { createTranslator } from "next-intl";
import fr from "@/messages/fr.json";
import en from "@/messages/en.json";
import ar from "@/messages/ar.json";

const MESSAGES = { fr, en, ar } as const;
type Kind = "verify" | "reset";

const transport = nodemailer.createTransport({
  host: process.env.SMTP_HOST || "localhost",
  port: Number(process.env.SMTP_PORT || 1025),
  secure: process.env.SMTP_SECURE === "true",
  auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASSWORD || "" } : undefined,
});

export async function sendMail(kind: Kind, to: string, locale: string | undefined, url: string) {
  const loc = (locale && locale in MESSAGES ? locale : "fr") as keyof typeof MESSAGES;
  const t = createTranslator({ locale: loc, messages: MESSAGES[loc], namespace: "mail" });
  const subject = t(`${kind}.subject`);
  const text = `${t(`${kind}.body`)}\n\n${url}\n\n${t(`${kind}.ignore`)}`;
  const dir = loc === "ar" ? "rtl" : "ltr";
  const html = `<div dir="${dir}" style="font-family:sans-serif;line-height:1.5"><p>${escape(t(`${kind}.body`))}</p>
<p><a href="${escape(url)}">${escape(t(`${kind}.action`))}</a></p><p style="color:#556">${escape(t(`${kind}.ignore`))}</p></div>`;
  await transport.sendMail({ from: process.env.SMTP_FROM || "Coloc <no-reply@coloc.local>", to, subject, text, html });
}

function escape(s: string) {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}
