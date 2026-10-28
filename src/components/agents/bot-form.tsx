"use client";

// A bot's profile as a form (Agents › Bots): its id, name, role, the clients it
// may call through, its company and monthly budget, a level for each area
// (locked areas shown, never choosable) and its limits. The same form adds a
// bot and edits one.

import { useState } from "react";
import {
  BOT_AREAS,
  BOT_COMPANIES,
  DEFAULT_BOT_LIMITS,
  LOCKED_BOT_AREAS,
  MAX_BOT_BUDGET_USD,
  MAX_BOT_LIMITS,
  defaultPermissions,
  levelOf,
  type BotCompany,
  type BotLevel,
  type BotLimits,
  type BotPermission,
} from "@convex/lib/botRules";
import { COMPANIES, companyIds, manyCompanies } from "@convex/lib/company";
import { areaOn } from "@convex/lib/featureGates";
import { AREA_NAMES as AREA_LABELS } from "@convex/lib/roles";
import { fieldClass, primaryButtonClass, quietButtonClass } from "@/components/panel";
import { messageOf } from "@/lib/errors";
import { cn } from "@/lib/utils";

/** Each area's short name in the matrix and on a row: the one list (convex/lib/roles.ts), so none is left unnamed. */
export const AREA_NAMES: Readonly<Record<string, string>> = AREA_LABELS;

const LIMIT_FIELDS: { key: keyof BotLimits; label: string }[] = [
  { key: "callsPer10Min", label: "Calls per 10 minutes" },
  { key: "changesPer10Min", label: "Changes per 10 minutes" },
  { key: "proposalsPerDay", label: "Proposals per day" },
];

export type Client = { id: string; kind: "token" | "oauth"; name: string };
export type ClientsChoice = "any" | { kind: "token" | "oauth"; id: string }[];
export type Draft = {
  botId: string;
  name: string;
  role: string;
  clients: ClientsChoice;
  permissions: BotPermission[];
  limits: BotLimits;
  /** The company it works for; null: not set. */
  company: BotCompany | null;
  /** The monthly budget as typed: "" for none. */
  budget: string;
};

/** Whom a bot may work for: each company this OS is run for, and both where there are two. */
const companyChoices = (): { value: BotCompany; label: string }[] => [
  ...companyIds().map((id) => ({ value: id, label: COMPANIES[id].name })),
  ...(manyCompanies() ? [{ value: "both" as const, label: "Both" }] : []),
];

const isBotCompany = (value: string): value is BotCompany => (BOT_COMPANIES as readonly string[]).includes(value);

/** A budget typed in the form: null when left empty. */
export const budgetOf = (typed: string): number | null => (typed.trim() === "" ? null : Number(typed));

/** Which clients a bot may call through, in words. */
export function clientSummary(clients: ClientsChoice, known: readonly Client[]): string {
  if (clients === "any") return "Any client";
  const names = clients.map((c) => known.find((k) => k.id === c.id)?.name ?? "A revoked client");
  return names.join(", ");
}

function Matrix({ permissions, onChange }: { permissions: BotPermission[]; onChange: (next: BotPermission[]) => void }) {
  const set = (area: (typeof BOT_AREAS)[number], level: BotLevel) => {
    const rest = permissions.filter((p) => p.area !== area);
    onChange(level === "none" ? rest : [...rest, { area, level }]);
  };
  return (
    <fieldset className="min-w-0">
      <legend className="text-sm font-medium text-ink">Permissions</legend>
      <p className="mt-1 text-xs text-ink-2">
        Read lets it call that area&apos;s read tools; write also its tools that change things (a task, a deal, a note).
      </p>
      <div className="mt-2 divide-y divide-line rounded-inner border border-line">
        {BOT_AREAS.filter(areaOn).map((area) => {
          const level = levelOf(permissions, area);
          return (
            <div key={area} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
              <span className="text-sm text-ink">{AREA_NAMES[area]}</span>
              <div role="radiogroup" aria-label={AREA_NAMES[area]} className="flex gap-1">
                {(["none", "read", "write"] as const).map((choice) => (
                  <button
                    key={choice}
                    type="button"
                    role="radio"
                    aria-checked={level === choice}
                    onClick={() => set(area, choice)}
                    className={cn(
                      "h-8 rounded-full px-3 text-xs font-medium capitalize outline-none focus-visible:ring-3 focus-visible:ring-ring/50",
                      level === choice ? "bg-brand-fill text-on-brand" : "text-ink-2 hover:bg-surface",
                    )}
                  >
                    {choice}
                  </button>
                ))}
              </div>
            </div>
          );
        })}
        {LOCKED_BOT_AREAS.map((area) => (
          <div key={area} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 opacity-60">
            <span className="text-sm text-ink-2">{AREA_NAMES[area] ?? area}</span>
            <span className="text-xs text-ink-3" aria-disabled>
              Never for a bot
            </span>
          </div>
        ))}
      </div>
    </fieldset>
  );
}

export function BotForm({
  initial,
  isNew,
  clients,
  onSave,
  onCancel,
}: {
  initial: Draft;
  isNew: boolean;
  clients: readonly Client[];
  onSave: (draft: Draft) => Promise<void>;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState<Draft>(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const chosen = draft.clients === "any" ? [] : draft.clients;
  const toggleClient = (client: Client, on: boolean) => {
    const rest = chosen.filter((c) => c.id !== client.id);
    setDraft({ ...draft, clients: on ? [...rest, { kind: client.kind, id: client.id }] : rest });
  };
  return (
    <form
      className="space-y-4"
      onSubmit={(event) => {
        event.preventDefault();
        setBusy(true);
        setError(null);
        onSave(draft)
          .catch((failure: unknown) => setError(messageOf(failure)))
          .finally(() => setBusy(false));
      }}
    >
      <div className="grid gap-3 sm:grid-cols-3">
        <label className="block text-sm text-ink">
          Id
          <input
            className={cn(fieldClass, "mt-1 h-10")}
            value={draft.botId}
            disabled={!isNew}
            onChange={(e) => setDraft({ ...draft, botId: e.target.value })}
            placeholder="fundraising"
            required
          />
        </label>
        <label className="block text-sm text-ink">
          Name
          <input
            className={cn(fieldClass, "mt-1 h-10")}
            value={draft.name}
            onChange={(e) => setDraft({ ...draft, name: e.target.value })}
            required
          />
        </label>
        <label className="block text-sm text-ink">
          Role
          <input
            className={cn(fieldClass, "mt-1 h-10")}
            value={draft.role}
            onChange={(e) => setDraft({ ...draft, role: e.target.value })}
            placeholder="Research"
          />
        </label>
      </div>

      <fieldset>
        <legend className="text-sm font-medium text-ink">Clients it may call through</legend>
        <label className="mt-2 flex items-center gap-2 text-sm text-ink">
          <input
            type="checkbox"
            checked={draft.clients === "any"}
            onChange={(e) => setDraft({ ...draft, clients: e.target.checked ? "any" : [] })}
          />
          Any connected client
        </label>
        {draft.clients !== "any" && (
          <div className="mt-2 space-y-1 pl-6">
            {clients.length === 0 && <p className="text-xs text-ink-3">No client is connected yet: Settings › Connections.</p>}
            {clients.map((client) => (
              <label key={client.id} className="flex items-center gap-2 text-sm text-ink">
                <input
                  type="checkbox"
                  checked={chosen.some((c) => c.id === client.id)}
                  onChange={(e) => toggleClient(client, e.target.checked)}
                />
                {client.name}
              </label>
            ))}
          </div>
        )}
      </fieldset>

      <div className="grid gap-3 sm:grid-cols-3">
        <label className="block text-sm text-ink">
          Company
          <select
            className={cn(fieldClass, "mt-1 h-10")}
            value={draft.company ?? ""}
            onChange={(e) => setDraft({ ...draft, company: isBotCompany(e.target.value) ? e.target.value : null })}
          >
            {draft.company === null && <option value="">Not set</option>}
            {companyChoices().map((choice) => (
              <option key={choice.value} value={choice.value}>
                {choice.label}
              </option>
            ))}
          </select>
        </label>
        <label className="block text-sm text-ink">
          Monthly budget (USD)
          <input
            type="number"
            min={0}
            max={MAX_BOT_BUDGET_USD}
            step={0.01}
            inputMode="decimal"
            className={cn(fieldClass, "mt-1 h-10")}
            value={draft.budget}
            onChange={(e) => setDraft({ ...draft, budget: e.target.value })}
            placeholder="None"
          />
        </label>
      </div>

      <Matrix permissions={draft.permissions} onChange={(permissions) => setDraft({ ...draft, permissions })} />

      <fieldset>
        <legend className="text-sm font-medium text-ink">Limits</legend>
        <div className="mt-2 grid gap-3 sm:grid-cols-3">
          {LIMIT_FIELDS.map(({ key, label }) => (
            <label key={key} className="block text-sm text-ink">
              {label}
              <input
                type="number"
                min={1}
                max={MAX_BOT_LIMITS[key]}
                className={cn(fieldClass, "mt-1 h-10")}
                value={draft.limits[key]}
                onChange={(e) => setDraft({ ...draft, limits: { ...draft.limits, [key]: Number(e.target.value) } })}
              />
            </label>
          ))}
        </div>
      </fieldset>

      {error !== null && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <button type="submit" className={primaryButtonClass} disabled={busy}>
          {isNew ? "Add bot" : "Save"}
        </button>
        <button type="button" className={quietButtonClass} onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}

export const blank = (): Draft => ({
  botId: "",
  name: "",
  role: "",
  clients: "any",
  permissions: defaultPermissions(),
  limits: DEFAULT_BOT_LIMITS,
  company: null,
  budget: "",
});
