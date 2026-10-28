"use client";

import { useMutation, useQuery } from "convex/react";
import { Loader2Icon, PencilIcon } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { api } from "@convex/_generated/api";
import { primaryButtonClass, quietButtonClass } from "@/components/panel";
import { DataCell, DataRow, rowActionClass } from "@/components/ui/data-table";
import { useViewer } from "@/hooks/use-viewer";
import { messageOf } from "@/lib/errors";
import { cn } from "@/lib/utils";
import { TelegramLink } from "./telegram-link";
import {
  GithubField,
  PersonCells,
  PersonGroup,
  TEAM_COLUMNS,
  TelegramField,
  TelegramHandle,
} from "./teammate-row";

/**
 * The owner's own two usernames, edited under the owner's row like any
 * teammate's: the one place either is set (`telegram.setMine`,
 * `team.setMyGithub`, both the owner's alone). Each is sent only if it was
 * changed. What was typed wins over a live update until it is saved.
 */
function OwnerEditor({
  telegramWas,
  githubWas,
  onClose,
}: {
  telegramWas: string;
  githubWas: string;
  onClose: () => void;
}) {
  const setTelegram = useMutation(api.telegram.setMine);
  const setGithub = useMutation(api.team.setMyGithub);
  const [telegram, editTelegram] = useState(telegramWas);
  const [github, editGithub] = useState(githubWas);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const telegramId = useId();
  const telegramHintId = useId();
  const githubId = useId();
  const githubHintId = useId();
  const formRef = useRef<HTMLFormElement>(null);

  // The button that opened the editor is gone: carry on from the first field.
  useEffect(() => formRef.current?.querySelector("input")?.focus(), []);

  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      if (telegram !== telegramWas) await setTelegram({ telegram });
      if (github !== githubWas) await setGithub({ github });
      onClose();
    } catch (failure) {
      setError(messageOf(failure));
      setBusy(false);
    }
  };

  return (
    <form ref={formRef} onSubmit={save} className="space-y-4 rounded-inner bg-surface p-4" noValidate>
      <TelegramField id={telegramId} hintId={telegramHintId} value={telegram} onChange={editTelegram} />
      <GithubField id={githubId} hintId={githubHintId} value={github} onChange={editGithub} />
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

/**
 * The owner's own row on the Team page, for the owner alone: nobody else is
 * shown it or can change the owner. Its Telegram and GitHub usernames are
 * set and reset here, as each teammate's are in their row.
 */
export function OwnerRow() {
  const viewer = useViewer();
  // The owner has no row in `members`: their Telegram username is kept with
  // the bot's settings, their GitHub one in `ownerProfiles`.
  const telegram = useQuery(api.telegram.settings, {});
  const github = useQuery(api.team.myGithub, {});
  const resetMine = useMutation(api.telegram.resetMine);
  const [editing, setEditing] = useState(false);
  const editRef = useRef<HTMLButtonElement>(null);
  const [wasEditing, setWasEditing] = useState(false);

  useEffect(() => {
    if (!editing && wasEditing) editRef.current?.focus();
  }, [editing, wasEditing]);

  const mine = telegram?.mine ?? null;
  const login = github?.login ?? null;
  const loaded = telegram !== undefined && github !== undefined;

  return (
    <PersonGroup>
      <DataRow>
        <PersonCells
          email={viewer.email}
          name={viewer.name}
          role="owner"
          companies={viewer.companies}
          telegram={
            telegram === undefined ? null : (
              <>
                <TelegramHandle username={mine} />
                {mine !== null && (
                  <TelegramLink
                    linked={telegram.mineLinked === true}
                    linkedAt={telegram.mineLinkedAt ?? null}
                    whose={viewer.email ?? "your username"}
                    onReset={() => resetMine({})}
                  />
                )}
              </>
            )
          }
          signedIn
          notes={[
            "You. The owner is set in the deployment and cannot be changed here.",
            ...(login ? [`GitHub: @${login}`] : []),
          ]}
        />
        <DataCell actions>
          {!editing && loaded && (
            <button
              ref={editRef}
              type="button"
              onClick={() => {
                setWasEditing(true);
                setEditing(true);
              }}
              className={rowActionClass}
            >
              <PencilIcon aria-hidden className="size-4" />
              Edit your usernames
            </button>
          )}
        </DataCell>
      </DataRow>
      {editing && (
        <DataRow plain>
          <DataCell colSpan={TEAM_COLUMNS} className="pt-0 pb-4">
            <OwnerEditor
              telegramWas={mine ? `@${mine}` : ""}
              githubWas={login ? `@${login}` : ""}
              onClose={() => setEditing(false)}
            />
          </DataCell>
        </DataRow>
      )}
    </PersonGroup>
  );
}
