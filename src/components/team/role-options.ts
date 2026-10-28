"use client";

import { useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { api } from "@convex/_generated/api";
import { BUILTIN_FOCUS } from "@convex/lib/focus";
import { MEMBER_ROLES, ROLE_LABELS, areasOf, isGrantableArea } from "@convex/lib/roles";
import { useViewer } from "@/hooks/use-viewer";

/** A role as `roles.list` sends it: built in, or one the owner named. */
export type RoleOption = FunctionReturnType<typeof api.roles.list>[number];

/** The three built-in roles, as the list sends them: what is offered until it arrives. */
const BUILT_IN: RoleOption[] = MEMBER_ROLES.map((id) => ({
  id,
  name: ROLE_LABELS[id],
  focus: BUILTIN_FOCUS[id],
  areas: areasOf(id).filter(isGrantableArea),
  builtin: true,
  people: null,
}));

/**
 * The roles a person can be given: the three built in, then the owner's own.
 * `loaded` is false until the list has arrived, when only the built-in ones
 * are offered. Asked only by a viewer with the Team page, whom the server
 * would answer.
 */
export function useRoleOptions(): { roles: RoleOption[]; loaded: boolean } {
  const list = useQuery(api.roles.list, useViewer().can("team") ? {} : "skip");
  return { roles: list ?? BUILT_IN, loaded: list !== undefined };
}
