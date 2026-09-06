import { clsx } from "clsx";
import type { ButtonHTMLAttributes, ReactNode } from "react";

type Variant = "primary" | "secondary" | "ghost";
type Size = "md" | "sm";

interface Props extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "type"> {
  variant?: Variant;
  size?: Size;
  /** Icon-only buttons get a 48px touch target on coarse pointers. */
  icon?: boolean;
  type?: "button" | "submit";
  children: ReactNode;
}

const base =
  "relative inline-flex shrink-0 items-center justify-center gap-1.5 rounded-md font-medium whitespace-nowrap select-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-500 disabled:opacity-50 disabled:pointer-events-none";

const variants: Record<Variant, string> = {
  primary: "bg-amber-500 text-neutral-950 hover:bg-amber-400 dark:bg-amber-400 dark:hover:bg-amber-300",
  secondary: "bg-neutral-950/5 text-neutral-950 hover:bg-neutral-950/10 dark:bg-white/10 dark:text-white dark:hover:bg-white/15",
  ghost: "text-neutral-700 hover:bg-neutral-950/5 hover:text-neutral-950 dark:text-neutral-300 dark:hover:bg-white/10 dark:hover:text-white",
};

const sizes: Record<Size, { text: string; icon: string }> = {
  md: { text: "text-base/6 sm:text-sm/6 py-2 px-3", icon: "p-2" },
  sm: { text: "text-sm/5 py-1.5 px-2.5", icon: "p-1.5" },
};

export function Button({ variant = "secondary", size = "md", icon = false, type = "button", className, children, ...rest }: Props) {
  return (
    <button type={type} className={clsx(base, variants[variant], icon ? sizes[size].icon : sizes[size].text, className)} {...rest}>
      {icon && <span className="absolute top-1/2 left-1/2 size-[max(100%,3rem)] -translate-1/2 pointer-fine:hidden" aria-hidden="true" />}
      {children}
    </button>
  );
}
