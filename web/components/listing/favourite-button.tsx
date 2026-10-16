"use client";
// The heart on a listing. The press is sent to the server (PUT or DELETE /v1/me/favourites/{id}) with a key made for
// that press; the button shows the state the API answered.
import { useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import { clsx } from "clsx";
import { setFavouriteAction } from "@/lib/actions/listings";

export function FavouriteButton({ listingId, initial, title, className }:
  { listingId: string; initial: boolean; title: string; className?: string }) {
  const t = useTranslations("card");
  const e = useTranslations("errors");
  const [on, setOn] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const press = () => start(async () => {
    setError(null);
    const r = await setFavouriteAction(listingId, !on, `fav-${crypto.randomUUID()}`);
    if (r.ok) setOn(!!r.favourite);
    else setError(e.has(r.error || "") ? e(r.error as string) : e("INTERNAL"));
  });
  return (
    <span className={clsx("inline-flex flex-col items-end", className)}>
      <button type="button" onClick={press} disabled={pending} aria-pressed={on}
        aria-label={`${on ? t("unsave") : t("save")}: ${title}`}
        className="grid size-11 place-items-center rounded-full border border-line bg-paper/95 text-door shadow-sm hover:border-door disabled:opacity-60">
        <svg viewBox="0 0 24 24" aria-hidden="true" className="size-5">
          <path d="M12 20.5s-7.5-4.6-7.5-10.1A4.3 4.3 0 0 1 12 7.7a4.3 4.3 0 0 1 7.5 2.7c0 5.5-7.5 10.1-7.5 10.1Z"
            fill={on ? "currentColor" : "none"} stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
        </svg>
      </button>
      {error && <span role="alert" className="mt-1 max-w-48 rounded-field bg-paper px-2 py-1 text-xs text-brick">{error}</span>}
    </span>
  );
}
