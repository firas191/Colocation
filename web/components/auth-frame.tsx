import { getTranslations } from "next-intl/server";
import type { ReactNode } from "react";
import { FloorPlan } from "./floor-plan";

/** Account pages: the form on the reading side, the plan beside it (above it on a phone, smaller). */
export async function AuthFrame({ title, lead, children }: { title: string; lead?: ReactNode; children: ReactNode }) {
  const p = await getTranslations("plan");
  const labels = { caption: p("caption"), kitchen: p("kitchen"), living: p("living"), bath: p("bath"), room: p("room"),
    free: p("free"), entrance: p("entrance") };
  return (
    <div className="grid items-stretch gap-8 md:grid-cols-[minmax(0,30rem)_1fr] md:gap-12">
      <section className="panel order-2 flex flex-col gap-6 p-6 shadow-[var(--shadow-lift)] sm:p-8 md:order-1">
        <div className="flex flex-col gap-3">
          <h1 className="page-title">{title}</h1>
          {lead && <p className="max-w-prose text-ink-soft">{lead}</p>}
        </div>
        {children}
      </section>
      <div className="order-1 hidden overflow-hidden rounded-[var(--radius-photo)] bg-night p-8 ring-1 ring-line md:order-2 md:grid md:place-items-center"
        style={{ backgroundImage: "linear-gradient(rgb(255 255 255 / 0.05) 1px, transparent 1px), linear-gradient(90deg, rgb(255 255 255 / 0.05) 1px, transparent 1px)", backgroundSize: "24px 24px" }}>
        <FloorPlan labels={labels} variant="blueprint" className="w-full max-w-xl" />
      </div>
    </div>
  );
}
