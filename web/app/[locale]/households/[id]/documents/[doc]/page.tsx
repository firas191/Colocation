// /households/[id]/documents/[doc] (platform P10, D-109): an exit inventory compared with the household's last entry
// inventory, row by row (matched by room and item by the API).
import { notFound } from "next/navigation";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { Link } from "@/i18n/navigation";
import { Notice } from "@/components/ui/field";
import { requireMember } from "@/lib/server/guard";
import { api } from "@/lib/server/api";
import { clientIp } from "@/lib/server/viewer";

interface Row { room: string; item: string; entry: string | null; exit: string | null; exit_notes: string | null; state: string }

export default async function Compare({ params }: { params: Promise<{ locale: string; id: string; doc: string }> }) {
  const { locale, id, doc } = await params;
  setRequestLocale(locale);
  const me = await requireMember(locale);
  if (!/^[0-9a-f-]{36}$/i.test(doc)) notFound();
  const t = await getTranslations("moveout");
  const e = await getTranslations("errors");
  const r = await api<{ entry_document_id: string | null; rows: Row[]; changed: number }>("GET", `/v1/documents/${doc}/comparison`,
    { userId: me.user_id, clientIp: await clientIp() });
  if (!r.ok && r.status === 404) notFound();
  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-6">
      <Link href={`/households/${id}/documents`} className="link-back">{t("backToDocuments")}</Link>
      <h1 className="page-title">{t("compareTitle")}</h1>
      {!r.ok ? <Notice tone="error">{e.has(r.error.code) ? e(r.error.code) : e("INTERNAL")}</Notice>
        : !r.data.entry_document_id ? <Notice>{t("noEntry")}</Notice> : (
          <>
            <p>{t("changedCount", { count: r.data.changed })}</p>
            <div className="overflow-x-auto">
              <table className="w-full border-collapse text-sm">
                <thead><tr>{["room", "item", "atEntry", "atExit", "state"].map((c) => <th key={c} className="border-b border-line p-2 text-start">{t(`cols.${c}`)}</th>)}</tr></thead>
                <tbody>
                  {r.data.rows.map((x, i) => (
                    <tr key={i} className={x.state === "same" ? "" : "bg-raised"}>
                      <td className="p-2">{x.room}</td><td className="p-2">{x.item}</td><td className="p-2">{x.entry || "—"}</td>
                      <td className="p-2">{x.exit || "—"}{x.exit_notes ? ` (${x.exit_notes})` : ""}</td><td className="p-2">{t(`states.${x.state}`)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
    </div>
  );
}
