"use client";

import { useMutation, useQuery } from "convex/react";
import { useState } from "react";
import { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";
import { ArchivedCards } from "@/components/pipeline/archived-cards";
import { INVESTOR_COLUMNS } from "@/lib/pipeline/stages";

/**
 * The investors taken off the board without being deleted, folded away under
 * it. Nothing is asked of the server until it is opened. Archiving is local:
 * it is not sent to Visible, and a Visible investor stays archived when the
 * daily read names it again. Restored, it goes back to the bottom of its stage.
 */
export function ArchivedInvestors() {
  const [open, setOpen] = useState(false);
  const archived = useQuery(api.investors.archived, open ? {} : "skip");
  const restore = useMutation(api.investors.restore);
  return (
    <ArchivedCards
      title="Archived investors"
      empty="Nothing is archived. Archive an investor from its card or the table to take it off the board without deleting it."
      failed="That investor could not be restored. Try again."
      open={open}
      onToggle={() => setOpen((was) => !was)}
      rows={archived}
      columns={INVESTOR_COLUMNS}
      onRestore={(id) => restore({ id: id as Id<"investors"> })}
    />
  );
}
