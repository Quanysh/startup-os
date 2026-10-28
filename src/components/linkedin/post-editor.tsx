"use client";

import { useMutation, useQuery } from "convex/react";
import { useId, useState, type ReactNode } from "react";
import { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";
import {
  ACCOUNT_KINDS,
  FIGURES,
  FIGURE_LABELS,
  MAX_FIGURE,
  MAX_LINK_LENGTH,
  MAX_PILLAR_LENGTH,
  MAX_POST_BODY,
  MAX_POST_TITLE,
  POST_STATUSES,
  POST_STATUS_LABELS,
  engagementRate,
  type AccountKind,
  type Figure,
  type PostStatus,
} from "@convex/lib/linkedin";
import { fieldClass, primaryButtonClass, quietButtonClass } from "@/components/panel";
import {
  ActionsHeader,
  Blank,
  DataBody,
  DataCell,
  DataHead,
  DataHeader,
  DataRow,
  DataRowHeader,
  DataTable,
  rowActionClass,
} from "@/components/ui/data-table";
import { COMPANIES, type CompanyId } from "@/lib/company";
import { messageOf } from "@/lib/errors";
import { dayLabel } from "@/lib/format";
import { fromLocalInput, toLocalInput, type PostRow } from "@/lib/linkedin/view";
import { cn } from "@/lib/utils";

/** What the form holds while it is typed in: its own, never re-keyed on server data. */
type Draft = {
  company: CompanyId;
  account: AccountKind;
  person: string;
  status: PostStatus;
  title: string;
  body: string;
  pillar: string;
  owner: string;
  plannedAt: string;
  publishedAt: string;
  link: string;
};

export const ACCOUNT_LABELS: Record<AccountKind, string> = {
  page: "Company page",
  person: "A person's profile",
};

/** A new post's form: on a day (planned for 9:00 that day), or on no day at all. */
export function draftOf(row: PostRow | null, company: CompanyId, day: string | null): Draft {
  if (row !== null) {
    return {
      company: row.company,
      account: row.account,
      person: row.person ?? "",
      status: row.status,
      title: row.title,
      body: row.body ?? "",
      pillar: row.pillar ?? "",
      owner: row.owner?.email ?? "",
      plannedAt: toLocalInput(row.plannedAt),
      publishedAt: toLocalInput(row.publishedAt),
      link: row.link ?? "",
    };
  }
  return {
    company,
    account: "page",
    person: "",
    status: day === null ? "idea" : "draft",
    title: "",
    body: "",
    pillar: "",
    owner: "",
    plannedAt: day === null ? "" : `${day}T09:00`,
    publishedAt: "",
    link: "",
  };
}

function Field({ label, children, wide }: { label: string; children: (id: string) => ReactNode; wide?: boolean }) {
  const id = useId();
  return (
    <div className={wide ? "sm:col-span-2" : undefined}>
      <label htmlFor={id} className="text-xs font-medium text-ink-2">
        {label}
      </label>
      <div className="mt-1">{children(id)}</div>
    </div>
  );
}

const input = cn(fieldClass, "h-9");

/**
 * Plan, write or change a post. Nothing is posted to LinkedIn from here: a
 * person publishes there, then marks the post published and pastes its link.
 */
export function PostEditor({
  row,
  company,
  companies,
  day,
  today,
  now,
  onDone,
}: {
  row: PostRow | null;
  company: CompanyId;
  companies: readonly CompanyId[];
  /** The calendar day a new post is planned for, or null. */
  day: string | null;
  today: string;
  now: number;
  onDone: () => void;
}) {
  const [draft, setDraft] = useState<Draft>(() => draftOf(row, company, day));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const save = useMutation(api.linkedin.save);
  const remove = useMutation(api.linkedin.remove);
  const people = useQuery(api.linkedin.people, { company: draft.company });
  const set = (patch: Partial<Draft>) => setDraft((was) => ({ ...was, ...patch }));

  const submit = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    const published = draft.status === "published";
    const planned = fromLocalInput(draft.plannedAt);
    const went = fromLocalInput(draft.publishedAt);
    try {
      await save({
        ...(row === null ? null : { id: row.id }),
        company: draft.company,
        account: draft.account,
        person: draft.account === "person" ? draft.person : null,
        status: draft.status,
        title: draft.title,
        body: draft.body.trim() === "" ? null : draft.body,
        pillar: draft.pillar.trim() === "" ? null : draft.pillar,
        owner: draft.owner === "" ? null : draft.owner,
        plannedAt: planned,
        publishedAt: published ? (went ?? planned ?? now) : null,
        link: published && draft.link.trim() !== "" ? draft.link : null,
      });
      onDone();
    } catch (failure) {
      setError(messageOf(failure));
    } finally {
      setBusy(false);
    }
  };

  const discard = async () => {
    if (row === null || busy) return;
    if (!window.confirm("Delete this post and its figures? This cannot be undone.")) return;
    try {
      await remove({ id: row.id });
      onDone();
    } catch (failure) {
      setError(messageOf(failure));
    }
  };

  const offered =
    (people ?? []).some((person) => person.email === draft.owner) || draft.owner === ""
      ? (people ?? [])
      : [...(people ?? []), { email: draft.owner, name: row?.owner?.name ?? null }];

  return (
    <div className="space-y-6">
      <form
        aria-label={row === null ? "Add a post" : "Edit the post"}
        className="grid gap-3 sm:grid-cols-2"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        {companies.length > 1 && row === null && (
          <Field label="Company">
            {(id) => (
              <select id={id} value={draft.company} onChange={(e) => set({ company: e.target.value as CompanyId, owner: "" })} className={input}>
                {companies.map((one) => (
                  <option key={one} value={one}>
                    {COMPANIES[one].name}
                  </option>
                ))}
              </select>
            )}
          </Field>
        )}
        <Field label="Posted from">
          {(id) => (
            <select id={id} value={draft.account} onChange={(e) => set({ account: e.target.value as AccountKind })} className={input}>
              {ACCOUNT_KINDS.map((kind) => (
                <option key={kind} value={kind}>
                  {kind === "page" ? `${COMPANIES[draft.company].name} page` : ACCOUNT_LABELS[kind]}
                </option>
              ))}
            </select>
          )}
        </Field>
        {draft.account === "person" && (
          <Field label="Whose profile (a name)">
            {(id) => <input id={id} required value={draft.person} maxLength={120} onChange={(e) => set({ person: e.target.value })} className={input} />}
          </Field>
        )}
        <Field label="Hook: the first line" wide>
          {(id) => <input id={id} required value={draft.title} maxLength={MAX_POST_TITLE} onChange={(e) => set({ title: e.target.value })} className={input} />}
        </Field>
        <Field label="Draft" wide>
          {(id) => (
            <>
              <textarea id={id} rows={7} value={draft.body} maxLength={MAX_POST_BODY} onChange={(e) => set({ body: e.target.value })} className={cn(fieldClass, "py-2")} />
              <p className="mt-1 text-xs text-ink-3">
                {draft.body.length.toLocaleString("en-US")} of {MAX_POST_BODY.toLocaleString("en-US")} characters
              </p>
            </>
          )}
        </Field>
        <Field label="Status">
          {(id) => (
            <select id={id} value={draft.status} onChange={(e) => set({ status: e.target.value as PostStatus })} className={input}>
              {POST_STATUSES.map((status) => (
                <option key={status} value={status}>
                  {POST_STATUS_LABELS[status]}
                </option>
              ))}
            </select>
          )}
        </Field>
        <Field label="Topic or pillar">
          {(id) => <input id={id} value={draft.pillar} maxLength={MAX_PILLAR_LENGTH} onChange={(e) => set({ pillar: e.target.value })} className={input} />}
        </Field>
        <Field label="Owner">
          {(id) => (
            <select id={id} value={draft.owner} onChange={(e) => set({ owner: e.target.value })} className={input}>
              <option value="">Nobody</option>
              {offered.map((person) => (
                <option key={person.email} value={person.email}>
                  {person.name ?? person.email}
                </option>
              ))}
            </select>
          )}
        </Field>
        <Field label="Planned for">
          {(id) => <input id={id} type="datetime-local" value={draft.plannedAt} onChange={(e) => set({ plannedAt: e.target.value })} className={input} />}
        </Field>
        {draft.status === "published" && (
          <>
            <Field label="Went out">
              {(id) => <input id={id} type="datetime-local" value={draft.publishedAt} onChange={(e) => set({ publishedAt: e.target.value })} className={input} />}
            </Field>
            <Field label="Link to the post on LinkedIn" wide>
              {(id) => <input id={id} type="url" value={draft.link} maxLength={MAX_LINK_LENGTH} placeholder="https://www.linkedin.com/posts/…" onChange={(e) => set({ link: e.target.value })} className={input} />}
            </Field>
          </>
        )}
        {row?.byClient != null && <p className="text-xs text-ink-3 sm:col-span-2">Added by {row.byClient}.</p>}
        {error !== null && (
          <p role="alert" className="text-sm text-destructive sm:col-span-2">
            {error}
          </p>
        )}
        <div className="flex flex-wrap gap-2 sm:col-span-2">
          <button type="submit" aria-disabled={busy} className={cn(primaryButtonClass, "aria-disabled:opacity-60")}>
            {row === null ? "Add the post" : "Save changes"}
          </button>
          <button type="button" onClick={onDone} className={quietButtonClass}>
            Cancel
          </button>
          {row !== null && (
            <button type="button" onClick={discard} className={cn(quietButtonClass, "text-destructive")}>
              Delete
            </button>
          )}
        </div>
      </form>

      {row !== null && row.status === "published" && <Figures row={row} today={today} now={now} />}
    </div>
  );
}

const percent = (rate: number | null) => (rate === null ? null : `${(rate * 100).toFixed(1)}%`);
const count = (value: number | null) => (value === null ? null : value.toLocaleString("en-US"));

/** A published post's dated snapshots, and a form to add the next. */
function Figures({ row, today, now }: { row: PostRow; today: string; now: number }) {
  const add = useMutation(api.linkedin.addSnapshot);
  const drop = useMutation(api.linkedin.removeSnapshot);
  const [day, setDay] = useState(today);
  const [values, setValues] = useState<Record<Figure, string>>(() => Object.fromEntries(FIGURES.map((f) => [f, ""])) as Record<Figure, string>);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    const figures = Object.fromEntries(
      FIGURES.flatMap((figure) => (values[figure].trim() === "" ? [] : [[figure, Number(values[figure])]])),
    ) as Partial<Record<Figure, number>>;
    try {
      await add({ postId: row.id as Id<"linkedinPosts">, day, ...figures });
      setValues(Object.fromEntries(FIGURES.map((f) => [f, ""])) as Record<Figure, string>);
    } catch (failure) {
      setError(messageOf(failure));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section aria-label="Figures" className="space-y-3 border-t border-line pt-5">
      <div>
        <h3 className="text-base">Figures</h3>
        <p className="mt-1 max-w-xl text-xs text-ink-2">
          Copy what LinkedIn shows under the post: each is a count to date. Add a snapshot every day or two for the first week, then weekly, and leave out a figure you did not read.
        </p>
      </div>
      {row.snapshots.length === 0 ? (
        <p className="text-sm text-ink-2">No figures yet.</p>
      ) : (
        <DataTable caption="Snapshots of this post's figures, oldest first" className="min-w-[40rem]" download="LinkedIn post figures">
          <DataHead>
            <DataHeader pinned>Read on</DataHeader>
            {FIGURES.map((figure) => (
              <DataHeader key={figure} numeric>
                {FIGURE_LABELS[figure]}
              </DataHeader>
            ))}
            <DataHeader numeric>Engagement</DataHeader>
            <ActionsHeader />
          </DataHead>
          <DataBody>
            {row.snapshots.map((snapshot) => (
              <DataRow key={snapshot.id}>
                <DataRowHeader pinned className="whitespace-nowrap">
                  {dayLabel(snapshot.day, now)}
                  {snapshot.byClient !== null && <span className="block text-xs font-normal text-ink-2">{snapshot.byClient}</span>}
                </DataRowHeader>
                {FIGURES.map((figure) => (
                  <DataCell key={figure} numeric>
                    {count(snapshot[figure]) ?? <Blank />}
                  </DataCell>
                ))}
                <DataCell numeric>{percent(engagementRate(snapshot)) ?? <Blank />}</DataCell>
                <DataCell actions>
                  <button
                    type="button"
                    className={rowActionClass}
                    aria-label={`Delete the figures read on ${snapshot.day}`}
                    onClick={() => {
                      if (window.confirm("Delete this snapshot?")) void drop({ id: snapshot.id as Id<"linkedinStats"> });
                    }}
                  >
                    Delete
                  </button>
                </DataCell>
              </DataRow>
            ))}
          </DataBody>
        </DataTable>
      )}
      <form
        aria-label="Add figures"
        className="grid gap-3 sm:grid-cols-3 lg:grid-cols-7"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <Field label="Read on">{(id) => <input id={id} type="date" required value={day} onChange={(e) => setDay(e.target.value)} className={input} />}</Field>
        {FIGURES.map((figure) => (
          <Field key={figure} label={FIGURE_LABELS[figure]}>
            {(id) => (
              <input
                id={id}
                type="number"
                inputMode="numeric"
                min={0}
                max={MAX_FIGURE}
                step={1}
                value={values[figure]}
                onChange={(e) => setValues((was) => ({ ...was, [figure]: e.target.value }))}
                className={input}
              />
            )}
          </Field>
        ))}
        {error !== null && (
          <p role="alert" className="text-sm text-destructive sm:col-span-3 lg:col-span-7">
            {error}
          </p>
        )}
        <div className="sm:col-span-3 lg:col-span-7">
          <button type="submit" aria-disabled={busy} className={cn(primaryButtonClass, "aria-disabled:opacity-60")}>
            Save figures
          </button>
        </div>
      </form>
    </section>
  );
}
