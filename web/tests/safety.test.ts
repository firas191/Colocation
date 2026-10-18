// Platform P12 (docs/PLATFORM_SPEC.md 9 P12, D-111): checks on the website's source that keep two promises.
// 1. Text from people and from the API is only ever shown as text: React escapes it, and nothing here bypasses that.
// 2. The browser never talks to n8n: only the server-side API client knows the API address and the signing secret,
//    and code that runs in the browser does not import server code.
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

const ROOT = path.resolve(__dirname, "..");
const DIRS = ["app", "components", "lib", "i18n"];

function files(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) out.push(...files(p));
    else if (/\.(tsx?|jsx?|mjs)$/.test(name)) out.push(p);
  }
  return out;
}

const SOURCES = DIRS.flatMap((d) => files(path.join(ROOT, d))).map((p) => ({
  rel: path.relative(ROOT, p).split(path.sep).join("/"),
  text: readFileSync(p, "utf8"),
}));
const isClient = (text: string) => /^\s*(\/\/[^\n]*\n|\/\*[\s\S]*?\*\/\s*)*["']use client["']/.test(text);

describe("text is shown as text", () => {
  it("no raw HTML, no eval", () => {
    const bad = SOURCES.filter((f) => /dangerouslySetInnerHTML|\.innerHTML\s*=|outerHTML\s*=|insertAdjacentHTML|\beval\(|new Function\(/.test(f.text));
    expect(bad.map((f) => f.rel)).toEqual([]);
  });

  it("React escapes what a person typed", () => {
    const html = renderToStaticMarkup(createElement("p", { title: '"><img src=x onerror=alert(1)>' }, "<script>alert(1)</script>"));
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;script&gt;");
  });

  it("links built from data are never javascript: URLs", () => {
    const bad = SOURCES.filter((f) => /href=\{\s*["'`]javascript:/i.test(f.text));
    expect(bad.map((f) => f.rel)).toEqual([]);
  });
});

describe("requests from other sites cannot act for a signed-in person (CSRF)", () => {
  // Changes go through server actions, which Next.js refuses when Origin does not match the host, or through the
  // Better Auth handler, which checks Origin against its own URL. A route handler that accepts POST would have
  // neither check, so only the auth handler may have one.
  it("route handlers that change things: only the auth handler", () => {
    const writers = SOURCES.filter((f) => /route\.ts$/.test(f.rel) && /export\s+(async\s+)?(function|const)\s+\{?\s*(POST|PUT|PATCH|DELETE)\b|export const \{[^}]*\b(POST|PUT|PATCH|DELETE)\b/.test(f.text));
    expect(writers.map((f) => f.rel)).toEqual(["app/api/auth/[...all]/route.ts"]);
  });

  it("the origin checks are not switched off", () => {
    const bad = SOURCES.filter((f) => /disableCSRFCheck|disableOriginCheck|allowedOrigins/.test(f.text));
    expect(bad.map((f) => f.rel)).toEqual([]);
    const cfg = readFileSync(path.join(ROOT, "next.config.ts"), "utf8");
    expect(cfg).not.toMatch(/allowedOrigins/);
  });
});

describe("the browser never calls n8n", () => {
  it("only the API client reads the API address and the signing key", () => {
    const readers = SOURCES.filter((f) => /FLATSHARE_(API_BASE|WEBSITE_KEY_ID|WEBSITE_SECRET)/.test(f.text)).map((f) => f.rel);
    expect(readers).toEqual(["lib/server/api.ts"]);
  });

  it("no source names n8n's address or its webhook paths", () => {
    const bad = SOURCES.filter((f) => /:5678|\/webhook\/|n8n:\d/.test(f.text));
    expect(bad.map((f) => f.rel)).toEqual([]);
  });

  it("browser code does not import server code", () => {
    const bad = SOURCES.filter((f) => isClient(f.text) && /from\s+["'](@\/lib\/server|\.\.?\/[^"']*server)\//.test(f.text.replace(/import type[^\n]*\n/g, "")));
    expect(bad.map((f) => f.rel)).toEqual([]);
  });

  it("server modules that hold secrets refuse to load in the browser", () => {
    for (const rel of ["lib/server/api.ts", "lib/server/auth.ts", "lib/server/mail.ts"]) {
      expect(SOURCES.find((f) => f.rel === rel)?.text, rel).toMatch(/import ["']server-only["']/);
    }
  });

  it("browser code reads no environment except public values", () => {
    const bad = SOURCES.filter((f) => isClient(f.text) && /process\.env\.(?!NEXT_PUBLIC_|NODE_ENV)/.test(f.text));
    expect(bad.map((f) => f.rel)).toEqual([]);
  });
});
