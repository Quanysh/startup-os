"use client";

import { useMutation, useQuery } from "convex/react";
import { PencilIcon } from "lucide-react";
import { useState } from "react";
import { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";
import {
  MAX_ANSWER_LENGTH,
  MAX_ANSWER_TAGS,
  type AnswerRow,
} from "@convex/lib/evidence";
import { useCompany } from "@/components/company-provider";
import { TypedFreshness } from "@/components/freshness/freshness-indicator";
import { fieldClass } from "@/components/panel";
import { Masonry } from "@/components/masonry";
import { Skeleton } from "@/components/ui/skeleton";
import { KindTag } from "@/components/ui/status-chip";
import { useViewer } from "@/hooks/use-viewer";
import { dayLabel } from "@/lib/format";
import { lastChange } from "@/lib/source-freshness";
import {
  AddButton,
  ChangedBy,
  DateField,
  RecordEditor,
  SelectField,
  TextAreaField,
  TextField,
  companyName,
  rowButton,
} from "./record-ui";

type Both = "both" | "us" | "kz";

function Editor({ row, onClose }: { row: AnswerRow | null; onClose: () => void }) {
  const upsert = useMutation(api.evidence.answerUpsert);
  const remove = useMutation(api.evidence.answerRemove);
  const { companies } = useViewer();
  const [question, setQuestion] = useState(row?.question ?? "");
  const [answer, setAnswer] = useState(row?.answer ?? "");
  const [tags, setTags] = useState(row?.tags.join(", ") ?? "");
  const [reviewed, setReviewed] = useState(row?.lastReviewedOn ?? "");
  const [company, setCompany] = useState<Both>(row?.company ?? "both");
  const tagList = tags.split(",").map((t) => t.trim()).filter(Boolean);

  return (
    <RecordEditor
      title={row === null ? "Add an approved answer" : "Edit answer"}
      description="A question as customers ask it, and the answer the company has approved."
      problem={() =>
        question.trim() === ""
          ? "An answer needs a question."
          : answer.trim() === ""
            ? "An answer cannot be empty."
            : answer.trim().length > MAX_ANSWER_LENGTH
              ? `That answer is too long (${MAX_ANSWER_LENGTH} characters at most).`
              : tagList.length > MAX_ANSWER_TAGS
                ? `An answer may have at most ${MAX_ANSWER_TAGS} tags.`
                : null
      }
      save={() =>
        upsert({
          ...(row === null ? null : { id: row.id }),
          question,
          answer,
          tags: tagList,
          company: company === "both" ? null : company,
          lastReviewedOn: reviewed === "" ? null : reviewed,
        })
      }
      remove={row === null ? undefined : () => remove({ id: row.id })}
      onClose={onClose}
    >
      <TextField label="Question" value={question} onChange={setQuestion} />
      <TextAreaField label="Approved answer" value={answer} onChange={setAnswer} rows={6} />
      <TextField label="Tags" value={tags} onChange={setTags} hint="Separated by commas, for finding it again." />
      <div className="grid gap-4 sm:grid-cols-2">
        <DateField label="Last reviewed" value={reviewed} onChange={setReviewed} hint="The day a person last checked this answer." />
        {companies.length > 1 && (
          <SelectField
            label="For"
            value={company}
            onChange={setCompany}
            options={[{ value: "both", label: "Both companies" }, ...companies.map((c) => ({ value: c, label: companyName(c) }))]}
          />
        )}
      </div>
    </RecordEditor>
  );
}

export function AnswerBankTab({ now }: { today: string; now: number }) {
  const company = useCompany();
  const all = useQuery(api.evidence.answers);
  const [editing, setEditing] = useState<Id<"answerBank"> | "new" | null>(null);
  const [search, setSearch] = useState("");
  if (all === undefined) return <Skeleton aria-busy className="h-64 w-full rounded-card" />;
  const inView = all.filter((a) => company === null || a.company === null || a.company === company);
  const words = search.trim().toLowerCase();
  const rows = inView.filter(
    (a) => words === "" || [a.question, a.answer, ...a.tags].some((text) => text.toLowerCase().includes(words)),
  );
  const edited = editing === "new" || editing === null ? null : (inView.find((a) => a.id === editing) ?? null);

  return (
    <div className="space-y-6">
      <section aria-labelledby="answers-heading" className="rounded-card bg-panel p-5 shadow-soft sm:p-6">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <div>
            <h2 id="answers-heading" className="text-base">
              Answer bank
            </h2>
            <p className="mt-0.5 max-w-2xl text-xs text-ink-2">
              Approved answers to questions customers ask. Claude drafts questionnaire replies from these and says so
              when none fits. Everything here is treated as approved: keep keys, secrets and customer data out.
            </p>
          </div>
          <div className="flex items-center gap-3">
            <TypedFreshness label="Answers" at={lastChange(inView)} />
            <AddButton label="Add an answer" onClick={() => setEditing("new")} />
          </div>
        </div>
        <div className="mt-4 max-w-sm">
          <input
            type="search"
            aria-label="Search the answer bank"
            placeholder="Search questions, answers and tags"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className={`${fieldClass} h-10`}
          />
        </div>
      </section>

      {inView.length === 0 ? (
        <p className="text-sm text-ink-2">Nothing here yet. Add the answers your team gives again and again.</p>
      ) : rows.length === 0 ? (
        <p className="text-sm text-ink-2">No answer matches that search.</p>
      ) : (
        <Masonry minColumnWidth={340} maxColumns={3} gap={16}>
          {rows.map((a) => (
            <article key={a.id} className="rounded-card bg-panel p-5 shadow-soft">
              <h3 className="text-sm font-medium text-ink">{a.question}</h3>
              <p className="mt-2 text-sm whitespace-pre-wrap text-ink-2">{a.answer}</p>
              {a.tags.length > 0 && (
                <ul className="mt-3 flex flex-wrap gap-1.5" aria-label="Tags">
                  {a.tags.map((tag) => (
                    <li key={tag}>
                      <KindTag tone="slate">{tag}</KindTag>
                    </li>
                  ))}
                </ul>
              )}
              <div className="mt-3 flex flex-wrap items-end justify-between gap-2">
                <div className="text-xs text-ink-2">
                  <p>
                    {a.lastReviewedOn === null ? "Never reviewed" : `Reviewed ${dayLabel(a.lastReviewedOn, now)}`}
                    {" · "}
                    {a.company === null ? "Both companies" : companyName(a.company)}
                  </p>
                  <ChangedBy by={a.changedBy} />
                </div>
                <button type="button" aria-label={`Edit answer: ${a.question}`} onClick={() => setEditing(a.id)} className={rowButton}>
                  <PencilIcon aria-hidden className="size-3.5" />
                  Edit
                </button>
              </div>
            </article>
          ))}
        </Masonry>
      )}

      {editing === "new" && <Editor row={null} onClose={() => setEditing(null)} />}
      {edited !== null && <Editor row={edited} onClose={() => setEditing(null)} />}
    </div>
  );
}
