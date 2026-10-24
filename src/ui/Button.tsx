import { clsx } from "clsx";
import type { ButtonHTMLAttributes, ComponentType, ReactNode, SVGProps } from "react";

type Variant = "primary" | "secondary" | "ghost" | "danger";
type Size = "md" | "sm";
type Icon = ComponentType<SVGProps<SVGSVGElement>>;

interface Props extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "type"> {
  variant?: Variant;
  /** md is 32px tall, sm is 26px. The only two sizes in the app. */
  size?: Size;
  /** An icon before the label; the padding on that side matches the vertical padding. */
  leading?: Icon;
  trailing?: Icon;
  type?: "button" | "submit";
  children: ReactNode;
}

/**
 * How a press shows, for a phone above all, where there's no hover to say
 * a button is live: what's pressed shrinks a little and comes back, quickly.
 * With reduced motion it dims instead.
 */
export const pressed = "transition-transform duration-150 ease-out active:scale-[0.97] motion-reduce:active:scale-100 motion-reduce:active:opacity-80";

/** A card that's a button: pressed the same way, shrinking less, being larger. */
export const pressedCard = "transition-transform duration-150 ease-out active:scale-[0.98] motion-reduce:active:scale-100 motion-reduce:active:opacity-80";

/**
 * A card with its button laid over it, marked `data-card`, and buttons of
 * its own on top (play, a menu): only the card's button presses the card.
 */
export const pressedCardWithButtons = "transition-transform duration-150 ease-out has-[[data-card]:active]:scale-[0.98] motion-reduce:has-[[data-card]:active]:scale-100 motion-reduce:has-[[data-card]:active]:opacity-80";

const base = clsx("relative inline-flex shrink-0 items-center justify-center gap-1.5 rounded-md font-medium whitespace-nowrap select-none focus-ring disabled:pointer-events-none disabled:opacity-40", pressed);

const variants: Record<Variant, string> = {
  // Inverted ink: the one thing on the screen you are most likely to want.
  primary: "bg-primary text-on-primary hover:bg-primary/85",
  secondary: "bg-raised text-ink ring-1 ring-line hover:ring-line-strong",
  ghost: "text-ink-2 hover:bg-raised hover:text-ink",
  danger: "bg-red-600 text-white hover:bg-red-500",
};

const sizes: Record<Size, { text: string; pad: string; lead: string; trail: string; icon: string }> = {
  md: { text: "text-base/6 sm:text-sm/5", pad: "px-3 py-1.5", lead: "py-1.5 pr-3 pl-1.5", trail: "py-1.5 pr-1.5 pl-3", icon: "p-2" },
  sm: { text: "text-sm/[1.125rem] sm:text-[0.8125rem]/[1.125rem]", pad: "px-2.5 py-1", lead: "py-1 pr-2.5 pl-1", trail: "py-1 pr-1 pl-2.5", icon: "p-[5px]" },
};

export function Button({ variant = "secondary", size = "md", leading: Lead, trailing: Trail, type = "button", className, children, ...rest }: Props) {
  const s = sizes[size];
  return (
    <button type={type} className={clsx(base, variants[variant], s.text, Lead ? s.lead : Trail ? s.trail : s.pad, className)} {...rest}>
      {Lead && <Lead className="size-4 shrink-0 fill-current" aria-hidden="true" />}
      {children}
      {Trail && <Trail className="size-4 shrink-0 fill-current" aria-hidden="true" />}
    </button>
  );
}

interface IconProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "type" | "children"> {
  /** What the button does, for screen readers and the tooltip. */
  label: string;
  icon: Icon;
  variant?: Exclude<Variant, "danger">;
  size?: Size;
  /** The glyph's size: 16px, unless an icon needs the room (the phone reader's dock draws its controls larger, and its thirty-second arrows carry a number). */
  glyph?: "size-4" | "size-5" | "size-6";
  type?: "button" | "submit";
  children?: ReactNode;
}

/** An icon-only button, with a 48px touch target on coarse pointers. */
export function IconButton({ label, icon: Glyph, variant = "ghost", size = "md", glyph = "size-4", type = "button", className, children, ...rest }: IconProps) {
  return (
    <button type={type} aria-label={label} title={label} className={clsx(base, variants[variant], sizes[size].icon, className)} {...rest}>
      <span className="absolute top-1/2 left-1/2 size-[max(100%,3rem)] -translate-1/2 pointer-fine:hidden" aria-hidden="true" />
      <Glyph className={clsx(glyph, "shrink-0 fill-current")} aria-hidden="true" />
      {children}
    </button>
  );
}
