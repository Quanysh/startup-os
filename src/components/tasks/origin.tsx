import { AGENT_NAMES } from "@convex/lib/agents";
import { PRODUCT } from "@convex/lib/identity";
import { KindTag } from "@/components/ui/status-chip";
import { formatPeriod } from "@/lib/format";
import { agentName } from "@/lib/notifications";
import type { Task } from "./task-card";

type Origin = NonNullable<Task["origin"]>;
type StandupOrigin = Extract<Origin, { source: "standup" }>;
type SuggestionOrigin = Extract<Origin, { source: "suggestion" }>;
type TelegramOrigin = Extract<Origin, { source: "telegram" }>;
type AgentOrigin = Extract<Origin, { source: "agent" }>;

/**
 * Where a card nobody typed into the board came from: "Added from the standup
 * of Oct 13", "Added from Telegram by Cora Founder" (without the name for a
 * viewer who is not told who that was), "Suggested by Ada Example" (a
 * suggester the viewer is not told about is "a teammate"), or "Added by
 * Claude (for Olga)" for one the owner's Claude made.
 */
export function originSentence(origin: Origin): string {
  switch (origin.source) {
    case "telegram":
      return origin.by === null ? "Added from Telegram" : `Added from Telegram by ${origin.by}`;
    case "suggestion":
      return `Suggested by ${origin.suggestedBy ?? "a teammate"}`;
    case "agent": {
      // A bot's profile id, where the card records one. Else which of the
      // owner's four: "Added by Claude (for Olga) · growth", or "· Engineering manager".
      const which =
        origin.bot !== undefined
          ? ` · ${origin.bot}`
          : origin.agent === undefined
            ? ""
            : ` · ${AGENT_NAMES[origin.agent]}`;
      return `${origin.for === null ? "Added by the owner's Claude" : `Added by ${agentName(origin.for)}`}${which}`;
    }
    case "standup":
      return `Added from the standup of ${formatPeriod("day", origin.meetingDate)}`;
  }
}

/**
 * The mark of a card the daily standup added (convex/standup.ts) or somebody
 * asked for in a Telegram group (convex/telegramInbound.ts): what it is, not
 * how it is doing, so a kind tag and never a status colour.
 */
export function StandupTag({ origin }: { origin: StandupOrigin | TelegramOrigin }) {
  return (
    <KindTag
      tone={origin.source === "telegram" ? "teal" : "violet"}
      title={originSentence(origin)}
      className="text-[11px]"
    >
      {origin.source === "telegram"
        ? "Telegram"
        : `Standup · ${formatPeriod("day", origin.meetingDate)}`}
    </KindTag>
  );
}

/**
 * The mark of a card sent with "Suggest a change" (convex/suggestions.ts):
 * feedback on the OS itself, named so on the board, where the "Added from"
 * filter shows these alone.
 */
export const FEEDBACK_LABEL = `Feedback on ${PRODUCT.name}`;
export function SuggestionTag({ origin }: { origin: SuggestionOrigin }) {
  return (
    <KindTag tone="sand" title={originSentence(origin)} className="text-[11px]">
      {FEEDBACK_LABEL}
    </KindTag>
  );
}

/**
 * The mark of a card the owner's Claude made through the agent endpoint
 * (convex/mcp.ts). A bot's card shows that bot's id; any other stays "Claude".
 */
export function AgentTag({ origin }: { origin: AgentOrigin }) {
  return (
    <KindTag tone="plum" title={originSentence(origin)} className="text-[11px]">
      {origin.bot ?? "Claude"}
    </KindTag>
  );
}

/** The tag for wherever a card came from. */
export function OriginTag({ origin }: { origin: Origin }) {
  switch (origin.source) {
    case "suggestion":
      return <SuggestionTag origin={origin} />;
    case "agent":
      return <AgentTag origin={origin} />;
    case "standup":
    case "telegram":
      return <StandupTag origin={origin} />;
  }
}
