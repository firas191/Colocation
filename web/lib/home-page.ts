// Shared loading of a household page (platform P5, P6): the household (for its name, role and currency) and one list.
import "server-only";
import { notFound } from "next/navigation";
import { api } from "@/lib/server/api";
import { clientIp } from "@/lib/server/viewer";
import type { Household } from "@/lib/home";

export async function loadHousehold<T>(userId: string, id: string, path: string | null, query?: Record<string, string>) {
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const o = { userId, clientIp: await clientIp() };
  const [h, d] = await Promise.all([api<Household>("GET", `/v1/households/${id}`, o),
    path ? api<T>("GET", `/v1/households/${id}${path}`, { ...o, query }) : Promise.resolve(null)]);
  if (!h.ok) notFound();
  return { h: h.data, d };
}
