import { clsx } from "clsx";
import type { ButtonHTMLAttributes } from "react";

type Variant = "primary" | "secondary" | "quiet";
const styles: Record<Variant, string> = {
  primary: "bg-door text-door-ink hover:brightness-110 disabled:opacity-60",
  secondary: "border border-ink/70 text-ink hover:bg-ink/5 disabled:opacity-60",
  quiet: "text-door underline-offset-4 hover:underline px-0",
};

export function Button({ variant = "primary", className, ...p }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant }) {
  return (
    <button
      {...p}
      className={clsx("inline-flex min-h-11 items-center justify-center gap-2 rounded-field px-5 text-[0.95rem] font-semibold",
        "transition-[filter,background-color] disabled:cursor-not-allowed", styles[variant], className)}
    />
  );
}
