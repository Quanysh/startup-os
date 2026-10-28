"use client";

import { useQuery } from "convex/react";
import { InfoIcon } from "lucide-react";
import Link from "next/link";
import { GatedLink } from "@/components/gated-link";
import { useSearchParams } from "next/navigation";
import { useState } from "react";
import { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";
import { MARKETS, MARKET_LABELS } from "@convex/lib/customerShape";
import { sourceOn } from "@convex/lib/featureGates";
import { useCompany } from "@/components/company-provider";
import { PageFreshness } from "@/components/freshness/freshness-indicator";
import { PageHeader } from "@/components/page-header";
import { Skeleton } from "@/components/ui/skeleton";
import { useNow } from "@/hooks/use-now";
import { pushDayLabel, registerIsStale } from "@/lib/customers/attention";
import { HEALTH_LABELS, baaMissing, registerDayOf } from "@/lib/customers/health";
import {
  HEALTH_ORDER,
  NO_FILTERS,
  applyFilters,
  assess,
  filtersFromParams,
  filtersToQuery,
  hasFilters,
  healthCounts,
  type CustomerFilters,
} from "@/lib/customers/view";
import { cn } from "@/lib/utils";
import { CustomerDrawer } from "./customer-drawer";
import { CustomerList } from "./customer-list";
import { PayingFigures } from "./paying-figures";

function Chip({
  filters,
  current,
  children,
}: {
  filters: CustomerFilters;
  current: boolean;
  children: React.ReactNode;
}) {
  return (
    <Link
      href={`/customers${filtersToQuery(filters)}`}
      aria-current={current ? "true" : undefined}
      className={cn(
        "inline-flex h-8 items-center gap-1.5 rounded-full px-3 text-sm text-ink-2 outline-none transition hover:bg-surface hover:text-ink focus-visible:ring-3 focus-visible:ring-ring/50",
        current && "bg-panel font-medium text-ink shadow-soft-sm",
      )}
    >
      {children}
    </Link>
  );
}

function Note({ children }: { children: React.ReactNode }) {
  return (
    <p className="flex items-start gap-2 text-sm text-ink-2">
      <InfoIcon aria-hidden className="mt-0.5 size-4 shrink-0 text-watch" />
      <span>{children}</span>
    </p>
  );
}

/**
 * /customers: every clinic in the client register with a health verdict and
 * the reason for it. Health is worked out here, as of the day the register was
 * last pushed.
 *
 * Clinic names are shown here and on Product › Kazakhstan › Clinics, both
 * read through `customers.list` and both for the Customers page's holders.
 */
export function CustomersView() {
  const data = useQuery(api.customers.list);
  const company = useCompany();
  const now = useNow();
  const filters = filtersFromParams(useSearchParams());
  // The open clinic is held by id, so a push landing while its drawer is open
  // updates the figures in it without closing it.
  const [openId, setOpenId] = useState<Id<"customers"> | null>(null);

  const header = (
    <PageHeader
      title="Customers"
      purpose="Every clinic in the client register, with a health verdict and the reason for it."
      aside={<PageFreshness page="customers" />}
    />
  );

  if (data === undefined || now === null) {
    return (
      <div className="space-y-6" aria-busy>
        {header}
        <Skeleton className="h-10 w-full max-w-xl rounded-full" />
        <Skeleton className="h-96 w-full rounded-card" />
      </div>
    );
  }

  const { lastPushAt } = data;
  // One company in view: only its market's clinics, and no market filter to offer.
  const customers =
    company === null ? data.customers : data.customers.filter((c) => c.market === company);
  if (customers.length === 0) {
    return (
      <div className="space-y-6">
        {header}
        <PayingFigures />
        <section className="rounded-card bg-panel p-5 shadow-soft sm:p-6">
          <h2 className="text-base">No clinics yet</h2>
          {/* The register push is the second company's feed (convex/lib/featureGates.ts):
              without it, a won deal is the only way in. */}
          {sourceOn("client_register") ? (
            <p className="mt-2 max-w-2xl text-sm text-ink-2">
              Clinics arrive with a push of the client register: export the register sheet to
              CSV, then run <code className="font-mono text-ink">pnpm push:customers</code> on it.
              The{" "}
              <GatedLink href="/settings/sources" className="text-ink underline underline-offset-2">
                sources page
              </GatedLink>{" "}
              shows whether its token is set.
            </p>
          ) : (
            <p className="mt-2 max-w-2xl text-sm text-ink-2">
              A clinic arrives here when its deal is marked won on{" "}
              <GatedLink href="/sales" className="text-ink underline underline-offset-2">
                the Sales page
              </GatedLink>
              .
            </p>
          )}
        </section>
      </div>
    );
  }

  const all = assess(customers, registerDayOf(lastPushAt, now));
  const live = all.filter((row) => !row.clinic.archived);
  const counts = healthCounts(all);
  const noBaa = live.filter((row) => baaMissing(row.clinic)).length;
  const archived = all.length - live.length;
  const shown = applyFilters(all, filters);
  const open = openId === null ? undefined : all.find((row) => row.clinic.id === openId);
  const noUsage = live.every((row) => row.clinic.lastUsageDate === null);

  return (
    <div className="space-y-6">
      {header}

      {/* The figures Dashboard › Customers shows, so its link lands on the same numbers. */}
      <PayingFigures />

      <div className="space-y-2">
        {/* When the register was pushed is the header's ("Updated …"). Once it
            is old, what that means for the verdicts is said here, by its day. */}
        {lastPushAt !== null && registerIsStale(lastPushAt, now) && (
          <Note>
            The client register was last pushed {pushDayLabel(lastPushAt, now)}. Nothing since
            then is known: each clinic reads as it stood that day.
          </Note>
        )}
        {noUsage && live.length > 0 && (
          <Note>
            No clinic has a usage date on record, so usage plays no part in any verdict here.
          </Note>
        )}
      </div>

      <nav aria-label="Filter clinics" className="flex flex-wrap items-center gap-1">
        <Chip filters={{ ...NO_FILTERS, archived: filters.archived }} current={!hasFilters(filters)}>
          All <span className="font-num text-ink-3">{live.length}</span>
        </Chip>
        {HEALTH_ORDER.map((level) => (
          <Chip
            key={level}
            filters={{ ...filters, health: level }}
            current={filters.health === level}
          >
            {HEALTH_LABELS[level]} <span className="font-num text-ink-3">{counts[level]}</span>
          </Chip>
        ))}
        {(company === null ? MARKETS : []).map((market) => (
          <Chip
            key={market}
            filters={{ ...filters, market: filters.market === market ? null : market }}
            current={filters.market === market}
          >
            {MARKET_LABELS[market]}
          </Chip>
        ))}
        {noBaa > 0 && (
          <Chip
            filters={{ ...filters, baaMissing: !filters.baaMissing }}
            current={filters.baaMissing}
          >
            No BAA date on record <span className="font-num text-ink-3">{noBaa}</span>
          </Chip>
        )}
      </nav>

      {shown.length === 0 ? (
        <section className="rounded-card bg-panel p-5 shadow-soft sm:p-6">
          <p className="text-sm text-ink-2">
            No clinics match these filters.{" "}
            <Link
              href={`/customers${filtersToQuery({ ...NO_FILTERS, archived: filters.archived })}`}
              className="text-ink underline underline-offset-2"
            >
              Clear filters
            </Link>
          </p>
        </section>
      ) : (
        <CustomerList rows={shown} now={now} showBaa={company !== "kz"} onOpen={setOpenId} />
      )}

      {archived > 0 && (
        <p className="text-sm text-ink-2">
          <Link
            href={`/customers${filtersToQuery({ ...filters, archived: !filters.archived })}`}
            className="text-ink underline underline-offset-2"
          >
            {filters.archived
              ? "Hide clinics no longer in the register"
              : archived === 1
                ? "Show 1 clinic no longer in the register"
                : `Show ${archived} clinics no longer in the register`}
          </Link>
        </p>
      )}

      {open && (
        <CustomerDrawer
          // Keyed by the clinic's id, never by its data: a push must not remount the form.
          key={open.clinic.id}
          clinic={open.clinic}
          health={open.health}
          now={now}
          onClose={() => setOpenId(null)}
        />
      )}
    </div>
  );
}
