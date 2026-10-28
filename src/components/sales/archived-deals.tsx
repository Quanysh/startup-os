"use client";

import { useMutation, useQuery } from "convex/react";
import { useState } from "react";
import { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";
import type { Market } from "@convex/lib/pipelineRules";
import { ArchivedCards } from "@/components/pipeline/archived-cards";
import { DEAL_COLUMNS } from "@/lib/pipeline/stages";

/**
 * The deals taken off the board without being deleted, folded away under the
 * table. Nothing is asked of the server until it is opened. A deal restored
 * goes back to the bottom of its stage, with everything it held.
 */
export function ArchivedDeals({ market }: { market: Market }) {
  const [open, setOpen] = useState(false);
  const archived = useQuery(api.deals.archived, open ? { market } : "skip");
  const restore = useMutation(api.deals.restore);
  return (
    <ArchivedCards
      title="Archived deals"
      empty="Nothing is archived. Archive deals from the table to take them off the board without deleting them."
      failed="That deal could not be restored. Try again."
      open={open}
      onToggle={() => setOpen((was) => !was)}
      rows={archived}
      columns={DEAL_COLUMNS}
      onRestore={(id) => restore({ id: id as Id<"deals"> })}
    />
  );
}
