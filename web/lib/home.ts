// Shapes of the household answers (docs/openapi.yaml, P5 and P6). Display only.
export interface Member { user_id: string; display_name: string | null; role: "flatmate" | "owner"; status: string; me: boolean }
export interface Household { household_id: string; name: string; jurisdiction_code: string; currency: string; exponent: number; my_role: "flatmate" | "owner";
  status: string; members: Member[]; my_balance_minor: number | null; address_text: string | null;
  announcements: Array<{ id: number; body: string; pinned: boolean; created_at: string; author: { display_name: string | null } | null }>;
  upcoming: Array<{ item_id: string; kind: string; label: string; due_on: string; amount: { amount_minor: number } | null }> }
export const money = (locale: string, minor: number | null | undefined, currency: string, exp: number) =>
  minor === null || minor === undefined ? "" : new Intl.NumberFormat(locale, { style: "currency", currency, maximumFractionDigits: exp }).format(minor / 10 ** exp);
