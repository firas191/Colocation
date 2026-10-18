import { clsx } from "clsx";
import type { ButtonHTMLAttributes } from "react";

type Variant = "primary" | "secondary" | "quiet" | "danger";
const styles: Record<Variant, string> = {
  primary: "btn btn-primary",
  secondary: "btn btn-secondary",
  quiet: "inline-flex min-h-10 items-center gap-2 rounded-full px-3 font-semibold text-door transition-colors hover:bg-door-soft",
  danger: "btn border border-brick/40 bg-paper text-brick hover:bg-brick hover:text-paper",
};

export function Button({ variant = "primary", className, ...p }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant }) {
  return (
    <button {...p} className={clsx(styles[variant], "disabled:cursor-not-allowed disabled:opacity-60 disabled:shadow-none disabled:translate-y-0", className)} />
  );
}
