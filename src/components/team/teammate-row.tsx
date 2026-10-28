"use client";

import { useMutation } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import {
  CircleCheckIcon,
  CircleDashedIcon,
  Loader2Icon,
  PencilIcon,
  ShieldAlertIcon,
  Trash2Icon,
} from "lucide-react";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { api } from "@convex/_generated/api";
import { GITHUB_IS_THE_OWNERS } from "@convex/lib/roleRules";
import {
  GRANTABLE_AREAS,
  OWNERS_ONLY,
  isSensitiveArea,
  ROLE_LABELS,
  isGrantableArea,
  roleKind,
  type Area,
  type GrantableArea,
  type Role,
} from "@convex/lib/roles";
import { fieldClass, primaryButtonClass, quietButtonClass } from "@/components/panel";
import {
  DataBody,
  DataCell,
  DataRow,
  DataRowHeader,
  rowActionClass,
} from "@/components/ui/data-table";
import { Label } from "@/components/ui/label";
import { KindTag, StatusChip, type KindTone } from "@/components/ui/status-chip";
import { useViewer } from "@/hooks/use-viewer";
import { COMPANIES, companyIds, type CompanyId } from "@/lib/company";
import { messageOf } from "@/lib/errors";
import { cn } from "@/lib/utils";
import { CompanyChecks, NO_COMPANY } from "./company-checks";
import {
  PageChecks,
  PagesNote,
  ROLE_HINT,
  pageNames,
  sensitiveNames,
} from "./page-checks";
import { useRoleOptions } from "./role-options";
import { TelegramLink } from "./telegram-link";

export type Teammate = FunctionReturnType<typeof api.team.list>[number];

// Kinds, not states: a hue each, told apart within their own column. The
// owner is the one role nobody is given, so it wears the plain slate.
const ROLE_TONE: Record<Role, KindTone> = {
  owner: "slate",
  cofounder: "violet",
  sales: "plum",
  engineer: "teal",
  // Every role the owner named wears one hue: the name tells them apart.
  custom: "sand",
};
/** A company's hue: the same two the targets table gives its scopes. */
const COMPANY_TONE: Record<CompanyId, KindTone> = { us: "teal", kz: "sand" };

/** The columns of the people table, in order. The last is the row's buttons. */
export const TEAM_COLUMNS = 7;

/** Said to a manager where the owner has the Telegram field. */
export const TELEGRAM_OWNERS = "Only the owner sets or resets a Telegram username.";

/** What the Telegram field says under itself, in the editor and the add form. */
export const TELEGRAM_HINT =
  "Optional. The bot tags them in the company's Telegram group when a task is given to them.";

/**
 * One person's rows, as a group of their own: the row that is read, and under
 * it whatever the owner has opened for them (the editor, or the question
 * before a removal). The line is drawn under the group, not between its rows.
 */
export function PersonGroup({ children }: { children: ReactNode }) {
  return (
    <DataBody
      // Each person is a body of their own, so the stripe counts people.
      stripe="groups"
      className="border-b border-line last:border-b-0 [&>tr]:border-b-0"
    >
      {children}
    </DataBody>
  );
}

/** Who someone is and what they have: the cells of a row that are only read. */
export function PersonCells({
  email,
  name,
  role,
  roleName,
  companies,
  areas,
  telegram,
  signedIn,
  notes = [],
}: {
  email: string | null;
  name: string | null;
  role: Role;
  /** What the role is called; left out, the built-in name for `role`. Shown as text. */
  roleName?: string;
  companies: readonly CompanyId[];
  /** A teammate's pages, each shown by name. Left out for the owner, who has them all. */
  areas?: readonly Area[];
  /** What the Telegram column holds: a username shown with its "@", or other words. */
  telegram: ReactNode;
  signedIn: boolean;
  /** Lines under the name, such as who the owner is. */
  notes?: readonly string[];
}) {
  return (
    <>
      <DataRowHeader pinned className="font-normal sm:max-w-[18rem]">
        {email !== null && <p className="text-sm font-medium break-all text-ink">{email}</p>}
        {name !== null && <p className="text-xs text-ink-2">{name}</p>}
        {notes.map((note) => (
          <p key={note} className="mt-1 text-xs text-ink-2">
            {note}
          </p>
        ))}
      </DataRowHeader>
      <DataCell className="whitespace-nowrap">
        <KindTag tone={ROLE_TONE[role]}>{roleName ?? ROLE_LABELS[role]}</KindTag>
      </DataCell>
      <DataCell>
        {/* The names in the usual order, with the comma a reader hears between them. */}
        <span className="flex flex-wrap gap-1">
          {companyIds().filter((id) => companies.includes(id)).map((id, index) => (
            <span key={id} className="inline-flex">
              {index > 0 && <span className="sr-only">, </span>}
              <KindTag tone={COMPANY_TONE[id]}>{COMPANIES[id].name}</KindTag>
            </span>
          ))}
        </span>
      </DataCell>
      <DataCell className="min-w-[14rem]">
        {areas === undefined ? (
          <p className="max-w-sm text-xs text-ink-2">Every page. {OWNERS_ONLY}</p>
        ) : (
          <>
            {pageNames(areas).length > 0 && (
              <div
                role="group"
                aria-label="Pages they can open"
                className="flex flex-wrap gap-1 text-[11px] text-ink-2"
              >
                {pageNames(areas).map((page) => (
                  <span key={page} className="rounded-full border border-line bg-panel px-2 py-0.5">
                    {page}
                  </span>
                ))}
              </div>
            )}
            {/* Who holds a sensitive page is seen at a glance: a warning chip each, apart. */}
            {sensitiveNames(areas).length > 0 && (
              <div
                role="group"
                aria-label="Sensitive pages they hold"
                className={cn("flex flex-wrap gap-1", pageNames(areas).length > 0 && "mt-1")}
              >
                {sensitiveNames(areas).map((page) => (
                  <StatusChip key={page} tone="warning" icon={ShieldAlertIcon}>
                    {page}
                  </StatusChip>
                ))}
              </div>
            )}
            <PagesNote
              areas={areas}
              companies={companies}
              className={cn("max-w-sm", areas.length > 0 && "mt-1")}
            />
          </>
        )}
      </DataCell>
      <DataCell className="whitespace-nowrap">{telegram}</DataCell>
      <DataCell className="whitespace-nowrap">
        {signedIn ? (
          <StatusChip tone="success" icon={CircleCheckIcon}>
            Yes
          </StatusChip>
        ) : (
          <StatusChip tone="neutral" icon={CircleDashedIcon}>
            Not yet
          </StatusChip>
        )}
      </DataCell>
    </>
  );
}

/**
 * Role, pages and companies of one teammate. The fields are read from the
 * row once, when the editor opens: a live update arriving while it is open
 * never replaces what has been chosen. The pages start as the person's own;
 * choosing a role replaces them with that role's usual ones.
 */
function TeammateEditor({ member, onClose }: { member: Teammate; onClose: () => void }) {
  const update = useMutation(api.team.update);
  const { companies: offered, isOwner } = useViewer();
  const { roles } = useRoleOptions();
  // A role that is gone, or not yet listed, stays on the person until another is chosen.
  const options = roles.some((option) => option.id === member.role)
    ? roles
    : [
        ...roles,
        {
          id: member.role,
          name: member.roleName ?? ROLE_LABELS[roleKind(member.role)],
          areas: [] as GrantableArea[],
        },
      ];
  const [role, setRole] = useState(member.role);
  const [githubWas] = useState(member.github ? `@${member.github}` : "");
  const [github, setGithub] = useState(githubWas);
  const githubId = useId();
  const githubHintId = useId();
  const [areas, setAreas] = useState<GrantableArea[]>(member.areas.filter(isGrantableArea));
  const [companies, setCompanies] = useState<CompanyId[]>([...member.companies]);
  // As it was when the editor opened; sent only if it was changed.
  const [telegramWas] = useState(member.telegram ? `@${member.telegram}` : "");
  const [telegram, setTelegram] = useState(telegramWas);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const roleId = useId();
  const telegramId = useId();
  const telegramHintId = useId();
  const hintId = useId();
  const roleRef = useRef<HTMLSelectElement>(null);

  // The button that opened the editor is gone: carry on from its first field.
  useEffect(() => roleRef.current?.focus(), []);

  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    if (busy) return;
    if (companies.length === 0) return setError(NO_COMPANY);
    setBusy(true);
    setError(null);
    try {
      await update({
        id: member.id,
        role,
        companies,
        areas,
        // The owner's alone to send: the server refuses it from anyone else.
        ...(!isOwner || telegram === telegramWas ? null : { telegram }),
        ...(!isOwner || github === githubWas ? null : { github }),
      });
      onClose();
    } catch (failure) {
      setError(messageOf(failure));
      setBusy(false);
    }
  };

  return (
    <form onSubmit={save} className="space-y-4 rounded-inner bg-surface p-4" noValidate>
      <div className="flex flex-wrap gap-x-8 gap-y-4">
        <div className="w-full space-y-1.5 sm:w-48">
          <Label htmlFor={roleId}>Role</Label>
          <select
            ref={roleRef}
            id={roleId}
            value={role}
            aria-describedby={hintId}
            onChange={(e) => {
              const next = options.find((option) => option.id === e.target.value);
              if (next === undefined) return;
              setRole(next.id);
              // The owner starts again from the role's pages. A manager keeps
              // the sensitive ones as the owner left them: they are not theirs
              // to give or take.
              const kept = isOwner ? [] : areas.filter(isSensitiveArea);
              const usual: readonly string[] = next.areas;
              setAreas(GRANTABLE_AREAS.filter((area) => [...usual, ...kept].includes(area)));
            }}
            className={`${fieldClass} h-10`}
          >
            {options.map((option) => (
              <option key={option.id} value={option.id}>
                {option.name}
              </option>
            ))}
          </select>
        </div>
        <CompanyChecks value={companies} onChange={setCompanies} offered={offered} />
      </div>
      <p id={hintId} className="text-xs text-ink-2">
        {ROLE_HINT}
      </p>
      <PageChecks value={areas} onChange={setAreas} sensitiveLocked={!isOwner} />
      <PagesNote areas={areas} companies={companies} />
      {isOwner ? (
        <TelegramField
          id={telegramId}
          hintId={telegramHintId}
          value={telegram}
          onChange={setTelegram}
        />
      ) : (
        <p className="text-xs text-ink-2">{TELEGRAM_OWNERS}</p>
      )}
      {isOwner ? (
        <GithubField id={githubId} hintId={githubHintId} value={github} onChange={setGithub} />
      ) : (
        <p className="text-xs text-ink-2">{GITHUB_IS_THE_OWNERS}</p>
      )}
      <p className="text-xs text-ink-2">A change holds from the next thing they open.</p>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        {/* aria-disabled, not disabled: a natively disabled button drops focus mid-request. */}
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

/** A person's Telegram username, typed with or without the "@". */
export function TelegramField({
  id,
  hintId,
  value,
  onChange,
}: {
  id: string;
  hintId: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <div className="max-w-md space-y-1.5">
      <Label htmlFor={id}>Telegram username</Label>
      <input
        id={id}
        type="text"
        autoComplete="off"
        autoCapitalize="none"
        spellCheck={false}
        placeholder="@username"
        value={value}
        aria-describedby={hintId}
        onChange={(e) => onChange(e.target.value)}
        className={`${fieldClass} h-10`}
      />
      <p id={hintId} className="text-xs text-ink-2">
        {TELEGRAM_HINT}
      </p>
    </div>
  );
}

/** What the GitHub field says under itself. */
export const GITHUB_HINT =
  "Optional. Lets their Today and Dashboard show their own pull requests first. Nothing is sent to GitHub.";

/** A person's GitHub username, typed with or without the "@". */
export function GithubField({
  id,
  hintId,
  value,
  onChange,
}: {
  id: string;
  hintId: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <div className="max-w-md space-y-1.5">
      <Label htmlFor={id}>GitHub username</Label>
      <input
        id={id}
        type="text"
        autoComplete="off"
        autoCapitalize="none"
        spellCheck={false}
        placeholder="@username"
        value={value}
        aria-describedby={hintId}
        onChange={(e) => onChange(e.target.value)}
        className={`${fieldClass} h-10`}
      />
      <p id={hintId} className="text-xs text-ink-2">
        {GITHUB_HINT}
      </p>
    </div>
  );
}

/** A username as the Telegram column shows it, or the words for none. */
export function TelegramHandle({ username }: { username: string | null }) {
  return !username ? (
    <span className="text-sm text-ink-3">Not set</span>
  ) : (
    <span className="text-sm text-ink">@{username}</span>
  );
}

/** Said on a manager's own row: the server's rule (`CANNOT_CHANGE_SELF`), shortly. */
export const SELF_NOTE = "You.";
/** Said on a row a manager is shown and may not change. */
export const BEYOND_NOTE = "Also on a company you are not on: not yours to change.";
/** Said to a manager on the row of someone else who manages the team. */
export const MANAGER_NOTE = "Manages the team: only the owner changes them.";

/**
 * One teammate: who they are, what they can open, and the two things the
 * viewer can do, where the person is theirs to change (`editable`: always for
 * the owner; for a teammate who manages the team, never their own row or
 * someone on a company they are not on). The server enforces that; this only
 * leaves out buttons that would be refused.
 */
export function TeammateRow({ member }: { member: Teammate }) {
  const remove = useMutation(api.team.remove);
  const resetLink = useMutation(api.team.resetTelegram);
  const { isOwner } = useViewer();
  const [mode, setMode] = useState<"view" | "edit" | "confirm">("view");
  const [removing, setRemoving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const editRef = useRef<HTMLButtonElement>(null);
  const removeRef = useRef<HTMLButtonElement>(null);
  const keepRef = useRef<HTMLButtonElement>(null);
  // Which button to hand focus back to once the row is at rest again.
  const back = useRef<"edit" | "remove" | null>(null);

  useEffect(() => {
    if (mode === "confirm") keepRef.current?.focus();
    if (mode !== "view" || back.current === null) return;
    (back.current === "edit" ? editRef : removeRef).current?.focus();
    back.current = null;
  }, [mode]);

  const rest = (from: "edit" | "remove") => {
    back.current = from;
    setMode("view");
  };

  const confirmRemove = async () => {
    if (removing) return;
    setRemoving(true);
    setError(null);
    try {
      await remove({ id: member.id });
      // The row goes with the next list; nothing more to do here.
    } catch (failure) {
      setError(messageOf(failure, "That person could not be removed. Try again."));
      rest("remove");
    } finally {
      setRemoving(false);
    }
  };

  return (
    <PersonGroup>
      <DataRow>
        <PersonCells
          email={member.email}
          name={member.name}
          role={roleKind(member.role)}
          roleName={member.roleName}
          companies={member.companies}
          areas={member.areas}
          telegram={
            <>
              <TelegramHandle username={member.telegram} />
              {member.telegram !== null && (
                <TelegramLink
                  linked={member.telegramLinked}
                  linkedAt={member.telegramLinkedAt}
                  whose={member.email}
                  // The owner's alone: a manager reads the state and has no button.
                  onReset={isOwner ? () => resetLink({ id: member.id }) : undefined}
                />
              )}
            </>
          }
          signedIn={member.signedIn}
          notes={[
            ...(member.self
              ? [SELF_NOTE]
              : member.editable
                ? []
                : [member.areas.includes("team") ? MANAGER_NOTE : BEYOND_NOTE]),
            ...(member.github ? [`GitHub: @${member.github}`] : []),
          ]}
        />
        <DataCell actions>
          {mode === "view" && member.editable && (
            <>
              <button
                ref={editRef}
                type="button"
                onClick={() => {
                  setError(null);
                  setMode("edit");
                }}
                className={rowActionClass}
              >
                <PencilIcon aria-hidden className="size-4" />
                Edit<span className="sr-only"> {member.email}</span>
              </button>
              <button
                ref={removeRef}
                type="button"
                onClick={() => {
                  setError(null);
                  setMode("confirm");
                }}
                className={`${rowActionClass} hover:text-destructive`}
              >
                <Trash2Icon aria-hidden className="size-4" />
                Remove<span className="sr-only"> {member.email}</span>
              </button>
            </>
          )}
        </DataCell>
      </DataRow>

      {/* Opened under the person's row, across the table: the form keeps its own draft. */}
      {(mode !== "view" || error !== null) && (
        <DataRow plain>
          <DataCell colSpan={TEAM_COLUMNS} className="pt-0 pb-4">
            {mode === "edit" && <TeammateEditor member={member} onClose={() => rest("edit")} />}

            {mode === "confirm" && (
              <div className="rounded-inner bg-surface p-4">
                <p className="text-sm text-ink">
                  Remove this person? Their open sessions end at once, and their tasks stay
                  assigned to a removed teammate.
                </p>
                <div className="mt-3 flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={confirmRemove}
                    aria-disabled={removing}
                    className="inline-flex h-10 items-center justify-center gap-2 rounded-full px-4 text-sm font-medium text-destructive outline-none transition hover:bg-destructive/10 focus-visible:ring-3 focus-visible:ring-ring/50 aria-disabled:opacity-60"
                  >
                    {removing && <Loader2Icon aria-hidden className="size-4 animate-spin" />}
                    Remove from the team
                  </button>
                  <button
                    ref={keepRef}
                    type="button"
                    onClick={() => rest("remove")}
                    className={quietButtonClass}
                  >
                    Keep
                  </button>
                </div>
              </div>
            )}

            {error && mode !== "edit" && (
              <p role="alert" className={cn("text-sm text-destructive", mode !== "view" && "mt-2")}>
                {error}
              </p>
            )}
          </DataCell>
        </DataRow>
      )}
    </PersonGroup>
  );
}
