import { COMPANY_IDENTITY, PRODUCT } from "@convex/lib/identity";
import { StartupMark } from "@/components/startup-mark";
import { cn } from "@/lib/utils";

// A placeholder logo: the mark, the company's name set in type, and the
// product's tag. Replace the wordmark with your own drawing (an <svg> with
// role="img" and the name as its label, so the page still names it).
export function StartupWordmark({ className }: { className?: string }) {
  const name = COMPANY_IDENTITY.us.name;
  return (
    <span
      role="img"
      aria-label={name}
      className={cn("text-lg leading-none font-semibold tracking-tight text-foreground", className)}
    >
      {name}
    </span>
  );
}

/** Mark and wordmark together, with the product tag beside them. */
export function StartupLogo({ className }: { className?: string }) {
  return (
    <span className={cn("inline-flex items-center gap-2", className)}>
      <StartupMark className="size-7 shrink-0" />
      <StartupWordmark />
      <span className="rounded-full bg-brand/10 px-1.5 py-0.5 text-[10px] font-semibold tracking-wide text-brand">
        {PRODUCT.shortName}
      </span>
    </span>
  );
}
