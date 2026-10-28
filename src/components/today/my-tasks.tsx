"use client";

import { useQuery } from "convex/react";
import { api } from "@convex/_generated/api";
import { useCompany } from "@/components/company-provider";
import { useViewer } from "@/hooks/use-viewer";

/** The viewer's board, for a viewer with the board, and the company it is narrowed to. */
export function useMyBoard() {
  const viewer = useViewer();
  const inView = useCompany();
  const allowed = viewer.can("board");
  const board = useQuery(api.tasks.board, allowed ? {} : "skip");
  // As the board does: a stored choice the viewer is not on narrows nothing.
  const company = inView !== null && viewer.companies.includes(inView) ? inView : null;
  return { allowed, board, company, email: viewer.email };
}
