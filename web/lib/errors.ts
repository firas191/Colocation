// Turns API error details into per-field message keys (messages/*.json "issues").
export interface Detail { field?: string; issue?: string; purpose?: string }

export function fieldErrors(details: Detail[] | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const d of details || []) {
    if (!d.field) continue;
    const field = d.field.split(".")[0].replace(/\[\d+\]$/, "");
    out[field] ||= d.issue || "type";
  }
  return out;
}

export const knownIssue = (issue: string) =>
  ["required", "type", "enum", "minimum", "maximum", "out_of_range", "invalid_format", "too_long", "unknown_parameter",
   "minLength", "maxLength", "pattern"].includes(issue) ? issue : "type";
