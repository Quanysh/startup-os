"use client";

import { useMutation } from "convex/react";
import { Loader2Icon, PencilIcon, PlusIcon, Trash2Icon } from "lucide-react";
import { useId, useState } from "react";
import { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";
import { FOCUSES, FOCUS_HINTS, FOCUS_LABELS, type Focus } from "@convex/lib/focus";
import {
  MAX_ROLES,
  MAX_ROLE_NAME_LENGTH,
  SUGGESTED_ROLES,
  roleNameKey,
} from "@convex/lib/roleRules";
import { GRANTABLE_AREAS, isPresetArea, type GrantableArea } from "@convex/lib/roles";
import { Panel, fieldClass, primaryButtonClass, quietButtonClass } from "@/components/panel";
import {
  ActionsHeader,
  DataBody,
  DataCell,
  DataHead,
  DataHeader,
  DataRow,
  DataRowHeader,
  DataTable,
  rowActionClass,
} from "@/components/ui/data-table";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { messageOf } from "@/lib/errors";
import { cn } from "@/lib/utils";
import { AREA_PAGES, PAGE_ORDER, pageNames } from "./page-checks";
import { useRoleOptions, type RoleOption } from "./role-options";

/** Said beside a role's usual pages, wherever they can be changed. */
export const PRESET_NOTE =
  "Changing a role's usual pages changes nobody's access. They are what is ticked the next time the role is chosen.";

/** The pages a role can start with, in the navigation's order: ordinary ones only. */
const PRESET_PAGES = PAGE_ORDER.filter(isPresetArea);

const ROLE_COLUMNS = 5;

type Draft = { name: string; focus: Focus; areas: GrantableArea[] };
const EMPTY: Draft = { name: "", focus: "general", areas: [] };

/** A role's name, what it is arranged for and its usual pages: the add form's and the editor's. */
function RoleFields({ draft, onChange }: { draft: Draft; onChange: (next: Draft) => void }) {
  const nameId = useId();
  const focusId = useId();
  const hintId = useId();
  const noteId = useId();
  return (
    <>
      <div className="flex flex-wrap gap-x-6 gap-y-4">
        <div className="w-full space-y-1.5 sm:w-64">
          <Label htmlFor={nameId}>Name</Label>
          <input
            id={nameId}
            type="text"
            autoComplete="off"
            maxLength={MAX_ROLE_NAME_LENGTH}
            value={draft.name}
            onChange={(e) => onChange({ ...draft, name: e.target.value })}
            className={`${fieldClass} h-10`}
          />
        </div>
        <div className="w-full space-y-1.5 sm:w-56">
          <Label htmlFor={focusId}>Arranged for</Label>
          <select
            id={focusId}
            value={draft.focus}
            aria-describedby={hintId}
            onChange={(e) => onChange({ ...draft, focus: e.target.value as Focus })}
            className={`${fieldClass} h-10`}
          >
            {FOCUSES.map((focus) => (
              <option key={focus} value={focus}>
                {FOCUS_LABELS[focus]}
              </option>
            ))}
          </select>
        </div>
      </div>
      <p id={hintId} className="text-xs text-ink-2">
        {FOCUS_HINTS[draft.focus]} This orders their Dashboard and Today. It opens no page.
      </p>
      <fieldset aria-describedby={noteId}>
        <legend className="text-sm font-medium text-ink">Usual pages</legend>
        <div className="mt-1.5 grid gap-x-5 gap-y-2 sm:grid-cols-2 lg:grid-cols-3">
          {PRESET_PAGES.map((area) => (
            <label key={area} className="flex min-h-6 items-start gap-2 text-sm text-ink">
              <input
                type="checkbox"
                checked={draft.areas.includes(area)}
                onChange={(e) =>
                  onChange({
                    ...draft,
                    // Rebuilt from the table, so the order sent never depends on the clicks.
                    areas: GRANTABLE_AREAS.filter((other) =>
                      other === area ? e.target.checked : draft.areas.includes(other),
                    ),
                  })
                }
                className="mt-0.5 size-4 shrink-0 accent-brand"
              />
              {AREA_PAGES[area]}
            </label>
          ))}
        </div>
        <p id={noteId} className="mt-2 max-w-2xl text-xs text-ink-2">
          {PRESET_NOTE}
        </p>
      </fieldset>
    </>
  );
}

function AddRole({ roles }: { roles: readonly RoleOption[] }) {
  const create = useMutation(api.roles.create);
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const headingId = useId();
  const taken = new Set(roles.map((role) => roleNameKey(role.name)));
  const offered = SUGGESTED_ROLES.filter((role) => !taken.has(roleNameKey(role.name)));

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (busy) return;
    if (draft.name.trim() === "") return setError("A role needs a name.");
    setBusy(true);
    setError(null);
    try {
      await create(draft);
      setDraft(EMPTY);
    } catch (failure) {
      setError(messageOf(failure));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} aria-labelledby={headingId} className="space-y-4" noValidate>
      <h3 id={headingId} className="text-sm font-medium text-ink">
        Add a role
      </h3>
      {offered.length > 0 && (
        <div role="group" aria-label="Suggested names" className="flex flex-wrap items-center gap-1.5">
          <span className="mr-1 text-xs text-ink-2">Start from:</span>
          {offered.map((role) => (
            <button
              key={role.name}
              type="button"
              onClick={() => {
                setError(null);
                setDraft({ name: role.name, focus: role.focus, areas: [...role.areas] });
              }}
              className="rounded-full border border-line bg-panel px-2.5 py-1 text-xs text-ink outline-none transition hover:border-brand hover:text-brand focus-visible:ring-3 focus-visible:ring-ring/50"
            >
              {role.name}
            </button>
          ))}
        </div>
      )}
      <RoleFields draft={draft} onChange={setDraft} />
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <button
          type="submit"
          aria-disabled={busy}
          className={cn(primaryButtonClass, "aria-disabled:opacity-60")}
        >
          {busy ? (
            <Loader2Icon aria-hidden className="size-4 animate-spin" />
          ) : (
            <PlusIcon aria-hidden className="size-4" />
          )}
          Add role
        </button>
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
      </div>
    </form>
  );
}

function RoleEditor({ role, onClose }: { role: RoleOption; onClose: () => void }) {
  const update = useMutation(api.roles.update);
  // Read once, when the editor opens: a live update never replaces what was typed.
  const [draft, setDraft] = useState<Draft>({
    name: role.name,
    focus: role.focus,
    areas: [...role.areas],
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await update({ id: role.id as Id<"roles">, ...draft });
      onClose();
    } catch (failure) {
      setError(messageOf(failure));
      setBusy(false);
    }
  };

  return (
    <form
      onSubmit={save}
      aria-label={`Edit ${role.name}`}
      className="space-y-4 rounded-inner bg-surface p-4"
      noValidate
    >
      <RoleFields draft={draft} onChange={setDraft} />
      {role.people !== null && role.people > 0 && (
        <p className="text-xs text-ink-2">
          {role.people === 1 ? "1 person has" : `${role.people} people have`} this role: their
          Dashboard and Today are rearranged at once.
        </p>
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <button
          type="submit"
          aria-disabled={busy}
          className={cn(primaryButtonClass, "aria-disabled:opacity-60")}
        >
          {busy && <Loader2Icon aria-hidden className="size-4 animate-spin" />}
          Save
        </button>
        <button type="button" onClick={onClose} className={quietButtonClass}>
          Cancel
        </button>
      </div>
    </form>
  );
}

function RoleRow({ role }: { role: RoleOption }) {
  const remove = useMutation(api.roles.remove);
  const [mode, setMode] = useState<"view" | "edit" | "confirm">("view");
  const [removing, setRemoving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pages = pageNames(role.areas);

  const confirmRemove = async () => {
    if (removing) return;
    setRemoving(true);
    setError(null);
    try {
      await remove({ id: role.id as Id<"roles"> });
    } catch (failure) {
      setError(messageOf(failure, "That role could not be deleted. Try again."));
      setMode("view");
    } finally {
      setRemoving(false);
    }
  };

  return (
    <DataBody stripe="groups" className="border-b border-line last:border-b-0 [&>tr]:border-b-0">
      <DataRow>
        <DataRowHeader pinned className="text-sm font-medium text-ink">
          {role.name}
        </DataRowHeader>
        <DataCell className="whitespace-nowrap text-sm text-ink">{FOCUS_LABELS[role.focus]}</DataCell>
        <DataCell className="min-w-[14rem] text-sm text-ink-2">
          {pages.length === 0 ? "None" : pages.join(", ")}
        </DataCell>
        <DataCell className="font-num text-sm text-ink">{role.people ?? ""}</DataCell>
        <DataCell actions>
          {role.builtin ? (
            <span className="text-xs text-ink-3">Built in</span>
          ) : (
            mode === "view" && (
              <>
                <button
                  type="button"
                  onClick={() => {
                    setError(null);
                    setMode("edit");
                  }}
                  className={rowActionClass}
                >
                  <PencilIcon aria-hidden className="size-4" />
                  Edit<span className="sr-only"> {role.name}</span>
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setError(null);
                    setMode("confirm");
                  }}
                  className={`${rowActionClass} hover:text-destructive`}
                >
                  <Trash2Icon aria-hidden className="size-4" />
                  Delete<span className="sr-only"> {role.name}</span>
                </button>
              </>
            )
          )}
        </DataCell>
      </DataRow>
      {(mode !== "view" || error !== null) && (
        <DataRow plain>
          <DataCell colSpan={ROLE_COLUMNS} className="pt-0 pb-4">
            {mode === "edit" && <RoleEditor role={role} onClose={() => setMode("view")} />}
            {mode === "confirm" && (
              <div className="rounded-inner bg-surface p-4">
                <p className="text-sm text-ink">
                  Delete this role? A role that people have is not deleted: give them another
                  first.
                </p>
                <div className="mt-3 flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={confirmRemove}
                    aria-disabled={removing}
                    className="inline-flex h-10 items-center justify-center gap-2 rounded-full px-4 text-sm font-medium text-destructive outline-none transition hover:bg-destructive/10 focus-visible:ring-3 focus-visible:ring-ring/50 aria-disabled:opacity-60"
                  >
                    {removing && <Loader2Icon aria-hidden className="size-4 animate-spin" />}
                    Delete role
                  </button>
                  <button type="button" onClick={() => setMode("view")} className={quietButtonClass}>
                    Keep
                  </button>
                </div>
              </div>
            )}
            {error && mode === "view" && (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            )}
          </DataCell>
        </DataRow>
      )}
    </DataBody>
  );
}

/**
 * The roles a teammate can be given: the owner's card. A role is a name, what
 * its people's Dashboard and Today are arranged for, and the pages ticked
 * when it is chosen. It opens nothing by itself, and the card says so where
 * the pages are changed. Only the owner is shown it; the server refuses
 * anyone else the three mutations.
 */
export function RolesCard() {
  const { roles, loaded } = useRoleOptions();
  return (
    <Panel aria-labelledby="team-roles">
      <h2 id="team-roles" className="text-base">
        Roles
      </h2>
      <p className="mt-1 max-w-2xl text-sm text-ink-2">
        A role is a name, what a person&rsquo;s Dashboard and Today are arranged for, and the
        pages ticked to begin with. Up to {MAX_ROLES} of your own, beside the three built in.
      </p>
      <DataTable caption="Roles" className="min-w-[40rem]" boxClassName="mt-2">
        <DataHead>
          <DataHeader pinned>Role</DataHeader>
          <DataHeader>Arranged for</DataHeader>
          <DataHeader>Usual pages</DataHeader>
          <DataHeader>People</DataHeader>
          <ActionsHeader />
        </DataHead>
        {roles.map((role) => (
          <RoleRow key={role.id} role={role} />
        ))}
      </DataTable>
      {!loaded && <Skeleton className="mt-2 h-10 rounded-inner" />}
      <div className="mt-5 border-t border-line pt-5">
        <AddRole roles={roles} />
      </div>
    </Panel>
  );
}
