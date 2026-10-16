import { getTranslations } from "next-intl/server";
import type { ReactNode } from "react";
import { FloorPlan } from "./floor-plan";

/** Account pages: the form on the reading side, the plan beside it (above it on a phone, smaller). */
export async function AuthFrame({ title, lead, children }: { title: string; lead?: ReactNode; children: ReactNode }) {
  const p = await getTranslations("plan");
  const labels = { caption: p("caption"), kitchen: p("kitchen"), living: p("living"), bath: p("bath"), room: p("room"),
    free: p("free"), entrance: p("entrance") };
  return (
    <div className="grid items-start gap-8 md:grid-cols-[minmax(0,28rem)_1fr] md:gap-16">
      <section className="order-2 flex flex-col gap-6 md:order-1">
        <div className="flex flex-col gap-3">
          <h1 className="text-3xl font-bold leading-tight tracking-tight">{title}</h1>
          {lead && <p className="max-w-prose text-ink-soft">{lead}</p>}
        </div>
        {children}
      </section>
      <FloorPlan labels={labels} className="order-1 mx-auto w-full max-w-[18rem] md:order-2 md:max-w-none md:pt-6" />
    </div>
  );
}
