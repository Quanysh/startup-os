import Link from "next/link";
import { cn } from "@/lib/utils";

const TABS = [
  { href: "/finance", label: "Overview" },
  { href: "/finance/plan", label: "Budget and runway" },
] as const;

/** The Finance page's two tabs. Both are the `finance` area's: no new nav item. */
export function FinanceTabs({ current }: { current: (typeof TABS)[number]["href"] }) {
  return (
    <nav aria-label="Finance" className="flex gap-1 rounded-full bg-surface p-1 w-fit">
      {TABS.map((tab) => {
        const here = tab.href === current;
        return (
          <Link
            key={tab.href}
            href={tab.href}
            aria-current={here ? "page" : undefined}
            className={cn(
              "inline-flex h-8 items-center rounded-full px-4 text-sm font-medium outline-none transition focus-visible:ring-3 focus-visible:ring-ring/50",
              here ? "bg-panel text-ink shadow-soft-sm" : "text-ink-2 hover:text-ink",
            )}
          >
            {tab.label}
          </Link>
        );
      })}
    </nav>
  );
}
