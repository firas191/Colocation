"use client";
// A header link that knows it is the current section (aria-current), so the reader sees where they are.
import { clsx } from "clsx";
import type { ReactNode } from "react";
import { Link, usePathname } from "@/i18n/navigation";

export function NavLink({ href, children, className, exact = false, label }:
  { href: string; children: ReactNode; className?: string; exact?: boolean; label?: string }) {
  const path = usePathname();
  const on = exact ? path === href : path === href || path.startsWith(href + "/");
  return (
    <Link href={href} aria-current={on ? "page" : undefined} aria-label={label}
      className={clsx("relative rounded-full px-3 py-2 text-[0.95rem] font-medium no-underline transition-colors",
        on ? "bg-door-soft text-door" : "text-ink hover:bg-raised", className)}>
      {children}
    </Link>
  );
}
