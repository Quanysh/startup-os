"use client";

import { useMutation } from "convex/react";
import { Loader2Icon, UserPlusIcon } from "lucide-react";
import { useId, useRef, useState, useSyncExternalStore } from "react";
import { api } from "@convex/_generated/api";
import { isGrantableArea, type GrantableArea } from "@convex/lib/roles";
import { fieldClass, primaryButtonClass } from "@/components/panel";
import { Label } from "@/components/ui/label";
import { useViewer } from "@/hooks/use-viewer";
import { type CompanyId } from "@/lib/company";
import { messageOf } from "@/lib/errors";
import { cn } from "@/lib/utils";
import { CompanyChecks, NO_COMPANY } from "./company-checks";
import { PageChecks, PagesNote, ROLE_HINT } from "./page-checks";
import { useRoleOptions, type RoleOption } from "./role-options";
import { GithubField, TelegramField } from "./teammate-row";

const noChange = () => () => {};

/** This site's address, known only in the browser. */
function useOrigin(): string | null {
  return useSyncExternalStore(
    noChange,
    () => window.location.origin,
    () => null,
  );
}

/**
 * Let a Google account in. No role is chosen and no page ticked to begin
 * with: what a person may open is picked, never left at a default. Choosing a
 * role ticks that role's usual pages; after that the boxes are the owner's to
 * change, and the role stays as the label it was.
 */
export function AddTeammate() {
  const add = useMutation(api.team.add);
  // The companies this viewer can put someone on: both for the owner, their
  // own for a teammate who manages the team.
  const { companies: offered, isOwner } = useViewer();
  const origin = useOrigin();
  const [email, setEmail] = useState("");
  // The three built in, and the ones the owner named.
  const { roles } = useRoleOptions();
  const [role, setRole] = useState<RoleOption["id"] | null>(null);
  const [github, setGithub] = useState("");
  const [areas, setAreas] = useState<GrantableArea[]>([]);
  const [companies, setCompanies] = useState<CompanyId[]>([...offered]);
  const [telegram, setTelegram] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const emailRef = useRef<HTMLInputElement>(null);
  const emailId = useId();
  const errorId = useId();
  const telegramId = useId();
  const telegramHintId = useId();
  const githubId = useId();
  const githubHintId = useId();

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (busy) return;
    // The server decides what an address is; these only save a round trip.
    if (email.trim() === "") return setError("That is not an email address.");
    if (role === null) return setError("Pick a role.");
    if (companies.length === 0) return setError(NO_COMPANY);
    setBusy(true);
    setError(null);
    try {
      await add({
        email,
        role,
        companies,
        areas,
        ...(!isOwner || telegram.trim() === "" ? null : { telegram }),
        ...(!isOwner || github.trim() === "" ? null : { github }),
      });
      setEmail("");
      setTelegram("");
      setGithub("");
      setRole(null);
      setAreas([]);
      setCompanies([...offered]);
      emailRef.current?.focus();
    } catch (failure) {
      setError(messageOf(failure));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="space-y-4" noValidate aria-describedby={error ? errorId : undefined}>
      <div className="max-w-md space-y-1.5">
        <Label htmlFor={emailId}>Google account email</Label>
        <input
          ref={emailRef}
          id={emailId}
          type="email"
          inputMode="email"
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className={`${fieldClass} h-10`}
        />
      </div>

      <fieldset>
        <legend className="text-sm font-medium text-ink">Start from a role</legend>
        <div className="mt-1.5 flex flex-wrap gap-x-5 gap-y-2">
          {roles.map((option) => (
            <label key={option.id} className="flex min-h-6 items-center gap-2 text-sm text-ink">
              <input
                type="radio"
                name={`${emailId}-role`}
                checked={role === option.id}
                onChange={() => {
                  setRole(option.id);
                  setAreas(option.areas.filter(isGrantableArea));
                }}
                className="size-4 accent-brand"
              />
              {option.name}
            </label>
          ))}
        </div>
        <p className="mt-1.5 text-xs text-ink-2">{ROLE_HINT}</p>
      </fieldset>

      <PageChecks value={areas} onChange={setAreas} sensitiveLocked={!isOwner} />

      <CompanyChecks value={companies} onChange={setCompanies} offered={offered} />

      {/* An empty set is worth a word only once a role has put one there. */}
      {role !== null && <PagesNote areas={areas} companies={companies} />}

      {/* The owner's alone: the server refuses a username from anyone else. */}
      {isOwner && (
        <TelegramField
          id={telegramId}
          hintId={telegramHintId}
          value={telegram}
          onChange={setTelegram}
        />
      )}
      {isOwner && (
        <GithubField id={githubId} hintId={githubHintId} value={github} onChange={setGithub} />
      )}

      <p className="max-w-2xl text-xs text-ink-2">
        Nothing is sent to them. The person signs in with that Google account at{" "}
        {origin === null ? (
          "this site's address"
        ) : (
          <span className="font-medium break-all text-ink">{origin}</span>
        )}
        {", "}and can use the OS from then on.
      </p>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        {/* aria-disabled, not disabled: a natively disabled button drops focus mid-request. */}
        <button
          type="submit"
          aria-disabled={busy}
          className={cn(primaryButtonClass, "aria-disabled:opacity-60")}
        >
          {busy ? (
            <Loader2Icon aria-hidden className="size-4 animate-spin" />
          ) : (
            <UserPlusIcon aria-hidden className="size-4" />
          )}
          Add to the team
        </button>
        {error && (
          <p id={errorId} role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
      </div>
    </form>
  );
}
