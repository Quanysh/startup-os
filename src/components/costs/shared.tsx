"use client";

import type { FunctionReturnType } from "convex/server";
import type { api } from "@convex/_generated/api";
import { CATEGORY_LABELS, type CostCategory } from "@convex/lib/costs";
import type { Currency } from "@convex/lib/metricRegistry";
import { KindTag, type KindTone } from "@/components/ui/status-chip";
import { formatMinor } from "@/lib/format";

export type Line = FunctionReturnType<typeof api.costs.list>[number];
export type Summary = FunctionReturnType<typeof api.costs.summary>;

export const NOT_KNOWN = "Not known yet";
export const CURRENCY_NAMES: Record<Currency, string> = { USD: "US dollars", KZT: "tenge" };

/**
 * The one place a category gets its colour. Kinds wear a hue, never a status
 * colour, and there are five hues for eight categories: two share where they
 * are unlikely to sit side by side, and the chip always says its name, so the
 * colour helps find a row and is never the only sign.
 */
export const CATEGORY_TONE: Record<CostCategory, KindTone> = {
  cloud: "teal",
  software: "violet",
  office: "sand",
  services: "plum",
  marketing: "teal",
  travel: "sand",
  taxes_fees: "slate",
  other: "slate",
};

export function CategoryTag({ category }: { category: CostCategory }) {
  return <KindTag tone={CATEGORY_TONE[category]}>{CATEGORY_LABELS[category]}</KindTag>;
}

/** An exact amount in tabular figures; an estimate wears "≈", said aloud as "about". */
export function Money({
  minor,
  currency,
  estimate = false,
}: {
  minor: number;
  currency: Currency;
  estimate?: boolean;
}) {
  return (
    <span className="font-num">
      {estimate && (
        <>
          <span aria-hidden>≈ </span>
          <span className="sr-only">about </span>
        </>
      )}
      {formatMinor(minor, currency)}
    </span>
  );
}

/** Common lines, offered as a start. A name and a category: never an amount. */
export const QUICK_ADD: readonly { name: string; category: CostCategory }[] = [
  { name: "AWS", category: "cloud" },
  { name: "Google Cloud", category: "cloud" },
  { name: "Vercel", category: "cloud" },
  { name: "Convex", category: "cloud" },
  { name: "GitHub", category: "software" },
  { name: "Linear", category: "software" },
  { name: "Slack", category: "software" },
  { name: "Google Workspace", category: "software" },
  { name: "Claude", category: "software" },
  { name: "OpenAI", category: "software" },
  { name: "Notion", category: "software" },
  { name: "Figma", category: "software" },
  { name: "Office rent", category: "office" },
  { name: "Internet", category: "office" },
  { name: "Accounting", category: "services" },
  { name: "Legal", category: "services" },
];

const chipClass =
  "inline-flex h-8 items-center rounded-full border border-line bg-panel px-3 text-xs font-medium text-ink-2 outline-none transition hover:border-ring hover:text-ink focus-visible:ring-3 focus-visible:ring-ring/50";

/** The quick-add chips. A click opens the form with the name and category filled in; nothing is saved. */
export function QuickAdd({
  onPick,
  label = "Common lines",
}: {
  onPick: (preset: { name: string; category: CostCategory }) => void;
  label?: string;
}) {
  return (
    <ul aria-label={label} className="flex flex-wrap gap-1.5">
      {QUICK_ADD.map((preset) => (
        <li key={preset.name}>
          <button type="button" onClick={() => onPick(preset)} className={chipClass}>
            {preset.name}
          </button>
        </li>
      ))}
    </ul>
  );
}
