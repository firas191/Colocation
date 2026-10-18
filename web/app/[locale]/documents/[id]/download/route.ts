// Download of a household document (platform P9, D-108): the API checks membership and signs a short-lived URL to the
// PDF; this only redirects to it. The storage key never reaches the browser.
import { NextResponse } from "next/server";
import { api } from "@/lib/server/api";
import { clientIp, getViewer } from "@/lib/server/viewer";

export async function GET(_req: Request, { params }: { params: Promise<{ locale: string; id: string }> }) {
  const { id } = await params;
  const v = await getViewer();
  if (!v?.userId || !/^[0-9a-f-]{36}$/i.test(id)) return new NextResponse("Not found", { status: 404 });
  const r = await api<{ download: { url: string } | null }>("GET", `/v1/documents/${id}`, { userId: v.userId, clientIp: await clientIp() });
  if (!r.ok || !r.data.download) return new NextResponse("Not found", { status: 404 });
  return NextResponse.redirect(r.data.download.url, 302);
}
