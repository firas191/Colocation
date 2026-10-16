// Right-to-left (PLATFORM_SPEC 6.4): components use logical classes only (ms-, ps-, start-, text-start...), so the
// Arabic pages mirror without a second stylesheet. A physical class (ml-4, left-0, text-right...) fails this test.
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.join(__dirname, "..");
const PHYSICAL = /(?<![\w-])(?:-?(?:ml|mr|pl|pr|left|right|border-l|border-r|rounded-l|rounded-r|rounded-tl|rounded-tr|rounded-bl|rounded-br|scroll-ml|scroll-mr)-[\w./[\]-]+|text-left|text-right|float-left|float-right)(?![\w-])/g;

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = path.join(dir, f);
    if (["node_modules", ".next", "e2e", "tests"].includes(f)) return [];
    return statSync(p).isDirectory() ? files(p) : p.endsWith(".tsx") ? [p] : [];
  });
}

describe("logical classes only", () => {
  it("no physical left/right classes in components and pages", () => {
    const found: string[] = [];
    for (const f of files(ROOT)) {
      for (const m of readFileSync(f, "utf8").matchAll(/className=(?:"([^"]*)"|\{`([^`]*)`\}|\{[^}]*?"([^"]*)")/g)) {
        for (const hit of (m[1] || m[2] || m[3] || "").match(PHYSICAL) || []) found.push(`${path.relative(ROOT, f)}: ${hit}`);
      }
    }
    expect(found).toEqual([]);
  });
});
