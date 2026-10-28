"use client";

import { useMutation } from "convex/react";
import { useId, useState } from "react";
import { api } from "@convex/_generated/api";
import {
  CADENCE_WEEKS,
  FIGURES,
  FIGURE_LABELS,
  MAX_TARGET_PER_WEEK,
  MIN_IMPRESSIONS_FOR_RATE,
  STATS_WINDOW_DAYS,
  cadenceVerdict,
  cadenceWeeks,
  growthWeeks,
  topPosts,
  weekWords,
  windowTotals,
  type CadenceWeek,
  type DatedPost,
} from "@convex/lib/linkedin";
import { Sparkline } from "@/components/metrics/sparkline";
import { fieldClass, primaryButtonClass } from "@/components/panel";
import { StatusChip } from "@/components/ui/status-chip";
import {
  Blank,
  DataBody,
  DataCell,
  DataHead,
  DataHeader,
  DataRow,
  DataRowHeader,
  DataTable,
} from "@/components/ui/data-table";
import { COMPANIES, type CompanyId } from "@/lib/company";
import { messageOf } from "@/lib/errors";
import { dayLabel } from "@/lib/format";
import { cn } from "@/lib/utils";

const percent = (rate: number | null) => (rate === null ? "Not read yet" : `${(rate * 100).toFixed(1)}%`);
const count = (value: number | null) => (value === null ? "Not read yet" : value.toLocaleString("en-US"));

/** Posts a week, as bars: one hue, the count written above each, the target a dashed line. */
function CadenceBars({ weeks, target }: { weeks: readonly CadenceWeek[]; target: number | null }) {
  const peak = Math.max(1, target ?? 0, ...weeks.map((week) => week.published + week.planned));
  const height = 96;
  const y = (n: number) => Math.round((n / peak) * height);
  return (
    <div role="img" aria-label={`Posts a week: ${weeks.map((w) => `week of ${weekWords(w.weekStart)} ${w.published} published${w.planned > 0 ? `, ${w.planned} planned` : ""}`).join("; ")}.${target === null ? "" : ` Target ${target} a week.`}`}>
      <div className="relative flex items-end gap-1.5" style={{ height: height + 20 }} aria-hidden>
        {weeks.map((week) => (
          <div key={week.weekStart} className="flex min-w-0 flex-1 flex-col items-center justify-end">
            <span className="mb-0.5 text-xs text-ink-2">{week.published + week.planned}</span>
            <div className="flex w-full flex-col justify-end" style={{ height }}>
              {week.planned > 0 && (
                <div className="w-full rounded-t-sm border border-dashed border-[var(--chart-1)] bg-transparent" style={{ height: y(week.planned) }} />
              )}
              {week.published > 0 && (
                <div className={cn("w-full bg-[var(--chart-1)]", week.planned === 0 && "rounded-t-sm")} style={{ height: y(week.published) }} />
              )}
              {week.published + week.planned === 0 && <div className="w-full border-b border-line" />}
            </div>
          </div>
        ))}
        {target !== null && (
          <div className="pointer-events-none absolute inset-x-0 border-t-2 border-dashed border-ink-2" style={{ bottom: 20 + y(target) }}>
            <span className="absolute -top-5 right-0 rounded bg-panel px-1 text-xs text-ink-2">Target {target}</span>
          </div>
        )}
      </div>
      <div className="mt-1 flex gap-1.5" aria-hidden>
        {weeks.map((week) => (
          <span key={week.weekStart} className="min-w-0 flex-1 truncate text-center text-xs text-ink-3">
            {weekWords(week.weekStart)}
          </span>
        ))}
      </div>
      <p className="mt-2 text-xs text-ink-3">Solid is published, dashed is planned. The last bar is the week in progress.</p>
    </div>
  );
}

function TargetForm({ company, current }: { company: CompanyId; current: number | null }) {
  const set = useMutation(api.linkedin.setTarget);
  const id = useId();
  const [value, setValue] = useState(current === null ? "" : String(current));
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  return (
    <form
      aria-label={`${COMPANIES[company].name} posting target`}
      className="flex flex-wrap items-end gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        setError(null);
        setSaved(false);
        set({ company, postsPerWeek: value.trim() === "" ? 0 : Number(value) })
          .then(() => setSaved(true))
          .catch((failure: unknown) => setError(messageOf(failure)));
      }}
    >
      <div>
        <label htmlFor={id} className="text-xs font-medium text-ink-2">
          Target: posts a week
        </label>
        <input
          id={id}
          type="number"
          inputMode="numeric"
          min={0}
          max={MAX_TARGET_PER_WEEK}
          step={1}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          className={cn(fieldClass, "mt-1 h-9 w-24")}
        />
      </div>
      <button type="submit" className={cn(primaryButtonClass, "h-9")}>
        Set target
      </button>
      {saved && <span role="status" className="text-xs text-ink-2">Saved.</span>}
      {error !== null && (
        <span role="alert" className="text-xs text-destructive">
          {error}
        </span>
      )}
    </form>
  );
}

/**
 * The last 30 days' totals, the best posts by engagement rate, the posting
 * cadence against a target set here, and what the posts gained week by week.
 * Every figure is the latest snapshot someone or a bot entered: a figure nobody
 * gave is "Not read yet", never 0.
 */
export function StatsPanel({
  posts,
  today,
  now,
  companies,
  targets,
}: {
  posts: readonly DatedPost[];
  today: string;
  now: number;
  companies: readonly CompanyId[];
  targets: readonly { company: CompanyId; postsPerWeek: number }[];
}) {
  const totals = windowTotals(posts, today);
  const best = topPosts(posts);
  const growth = growthWeeks(posts, today);
  const firstGain = growth.findIndex((week) => week.impressions > 0);
  // A weekly chart needs three weeks since the first gain; fewer is a figure.
  const gains = firstGain === -1 ? [] : growth.slice(firstGain);
  const targetOf = (company: CompanyId) => targets.find((t) => t.company === company)?.postsPerWeek ?? null;

  return (
    <section aria-labelledby="li-stats" className="space-y-6 rounded-card bg-panel p-5 shadow-soft sm:p-6">
      <div>
        <h2 id="li-stats" className="text-lg">
          Stats
        </h2>
        <p className="mt-1 max-w-2xl text-xs text-ink-2">
          Posts that went out in the last {STATS_WINDOW_DAYS} days ({dayLabel(totals.from, now)} to {dayLabel(totals.to, now)}), each at its latest figures:{" "}
          {totals.published === 0
            ? "none went out."
            : `${totals.published} went out, ${totals.measured} ${totals.measured === 1 ? "has" : "have"} figures.`}
        </p>
      </div>

      <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-7">
        {FIGURES.map((figure) => (
          <div key={figure} className="rounded-inner bg-surface p-3">
            <dt className="text-xs text-ink-2">{FIGURE_LABELS[figure]}</dt>
            <dd className={cn("mt-1", totals.totals[figure] === null ? "text-sm text-ink-2" : "text-xl")}>{count(totals.totals[figure])}</dd>
          </div>
        ))}
        <div className="rounded-inner bg-surface p-3">
          <dt className="text-xs text-ink-2">Engagement rate</dt>
          <dd className={cn("mt-1", totals.rate === null ? "text-sm text-ink-2" : "text-xl")}>{percent(totals.rate)}</dd>
        </div>
      </dl>

      <div className="grid gap-6 lg:grid-cols-2">
        <div className="space-y-2">
          <h3 className="text-base">Top posts by engagement rate</h3>
          <p className="text-xs text-ink-2">
            (Reactions + comments + reposts) / impressions, from {MIN_IMPRESSIONS_FOR_RATE} impressions.
          </p>
          {best.length === 0 ? (
            <p className="text-sm text-ink-2">No published post has {MIN_IMPRESSIONS_FOR_RATE} impressions and its reactions, comments and reposts yet.</p>
          ) : (
            <DataTable caption="Top posts by engagement rate" download="LinkedIn top posts" className="min-w-[22rem]">
              <DataHead>
                <DataHeader pinned>Post</DataHeader>
                <DataHeader numeric>Rate</DataHeader>
                <DataHeader numeric>Impressions</DataHeader>
              </DataHead>
              <DataBody>
                {best.map((post) => (
                  <DataRow key={post.id}>
                    <DataRowHeader pinned className="max-w-[18rem] [overflow-wrap:anywhere]">
                      {post.title}
                    </DataRowHeader>
                    <DataCell numeric>{(post.rate * 100).toFixed(1)}%</DataCell>
                    <DataCell numeric>{post.impressions.toLocaleString("en-US")}</DataCell>
                  </DataRow>
                ))}
              </DataBody>
            </DataTable>
          )}
        </div>

        <div className="space-y-2">
          <h3 className="text-base">Impressions gained a week</h3>
          {gains.length >= 3 ? (
            <Sparkline
              ariaLabel={`Impressions gained a week, from the week of ${weekWords(gains[0]!.weekStart)}: ${gains.map((w) => w.impressions).join(", ")}`}
              points={gains.map((week) => ({
                label: `Week of ${weekWords(week.weekStart)}`,
                value: week.impressions,
                display: week.impressions.toLocaleString("en-US"),
              }))}
            />
          ) : gains.length > 0 ? (
            <p className="text-sm text-ink-2">
              {gains.at(-1)!.impressions.toLocaleString("en-US")} in the week of {weekWords(gains.at(-1)!.weekStart)}. A chart needs three weeks of figures.
            </p>
          ) : (
            <p className="text-sm text-ink-2">No figures yet.</p>
          )}
          <p className="text-xs text-ink-3">The step between a post&rsquo;s snapshots lands in the week of the later one.</p>
        </div>
      </div>

      <div className="space-y-4">
        <h3 className="text-base">Posting cadence</h3>
        <div className={cn("grid gap-6", companies.length > 1 && "lg:grid-cols-2")}>
          {companies.map((company) => {
            const mine = posts.filter((post) => post.company === company);
            const weeks = cadenceWeeks(mine, today, CADENCE_WEEKS);
            const target = targetOf(company);
            const verdict = cadenceVerdict(weeks, target);
            return (
              <div key={company} className="space-y-3">
                {companies.length > 1 && <h4 className="text-sm font-medium">{COMPANIES[company].name}</h4>}
                <CadenceBars weeks={weeks} target={target} />
                {verdict === null ? (
                  <p className="text-sm text-ink-2">{target === null ? "No target set." : "No finished week yet."}</p>
                ) : (
                  <p className="flex flex-wrap items-center gap-2 text-sm">
                    <StatusChip tone={verdict.verdict === "met" ? "success" : "warning"}>
                      {verdict.verdict === "met" ? "On target" : "Below target"}
                    </StatusChip>
                    <span>
                      {verdict.average.toFixed(1)} a week over the last {weeks.length - 1} finished weeks, against {verdict.target}.
                    </span>
                  </p>
                )}
                <TargetForm key={`${company}:${target}`} company={company} current={target} />
              </div>
            );
          })}
        </div>
        {totals.published === 0 && posts.length === 0 && <Blank>No posts yet.</Blank>}
      </div>
    </section>
  );
}
