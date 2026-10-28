// Reads what Claude Code prints with `-p --output-format stream-json
// --include-partial-messages`: one JSON object a line. For the chat's runner
// (scripts/assistantRunner.ts). Pure.
//
// Three things are taken from the stream and nothing else: the text of the
// model's latest message as it grows, the names of the chat's tools it used,
// and the final result. A tool's arguments and results are never kept. A line
// that cannot be read is counted and dropped. When the run failed, what is
// reported is one of a closed list of kinds (`RunnerFailure`): the error's
// own words are looked at here to tell the kind and go no further.

import {
  MAX_CHAT_ANSWER_LENGTH,
  isChatTool,
  type ChatTool,
  type RunnerFailure,
} from "../convex/lib/chatRules";

/** How Claude names a tool of the `startup-os` server. */
export const TOOL_PREFIX = "mcp__startup-os__";

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);

type Result = { subtype: string | null; isError: boolean; text: string | null };

export type Reader = ReturnType<typeof createReader>;

export function createReader() {
  let pending = "";
  let text = "";
  const steps: ChatTool[] = [];
  const seen = new Set<string>();
  let result: Result | null = null;
  let marked: string | null = null;
  let unread = 0;
  let changes = 0;

  const noteTool = (block: Json) => {
    const { id, name } = block;
    if (typeof name !== "string" || !name.startsWith(TOOL_PREFIX)) return;
    const tool = name.slice(TOOL_PREFIX.length);
    if (!isChatTool(tool)) return;
    // The same use arrives twice: as it starts, and in the whole message.
    if (typeof id === "string") {
      if (seen.has(id)) return;
      seen.add(id);
    }
    steps.push(tool);
    changes += 1;
  };

  const take = (line: string) => {
    if (line.trim() === "") return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      unread += 1;
      return;
    }
    if (!isObject(parsed)) {
      unread += 1;
      return;
    }
    if (parsed.type === "stream_event" && isObject(parsed.event)) {
      const event = parsed.event;
      if (event.type === "message_start") {
        if (text !== "") changes += 1;
        text = "";
      } else if (event.type === "content_block_delta" && isObject(event.delta)) {
        if (event.delta.type === "text_delta" && typeof event.delta.text === "string") {
          text += event.delta.text;
          changes += 1;
        }
      } else if (event.type === "content_block_start" && isObject(event.content_block)) {
        if (event.content_block.type === "tool_use") noteTool(event.content_block);
      }
    } else if (parsed.type === "assistant") {
      if (typeof parsed.error === "string") marked = parsed.error;
      const content = isObject(parsed.message) ? parsed.message.content : null;
      if (!Array.isArray(content)) return;
      const blocks = content.filter(isObject);
      const whole = blocks
        .filter((block) => block.type === "text" && typeof block.text === "string")
        .map((block) => block.text as string)
        .join("");
      if (whole !== "" && whole !== text) {
        text = whole;
        changes += 1;
      }
      for (const block of blocks) if (block.type === "tool_use") noteTool(block);
    } else if (parsed.type === "result") {
      result = {
        subtype: typeof parsed.subtype === "string" ? parsed.subtype : null,
        isError: parsed.is_error === true,
        text: typeof parsed.result === "string" ? parsed.result : null,
      };
    }
  };

  return {
    /** Some of the child's output, as it arrived. */
    push(chunk: string) {
      pending += chunk;
      const lines = pending.split("\n");
      pending = lines.pop() ?? "";
      for (const line of lines) take(line);
    },
    /** The output is over: read a last line that had no newline. */
    end() {
      const last = pending;
      pending = "";
      take(last);
    },
    /** The model's latest message, so far. */
    text: () => text,
    steps: (): ChatTool[] => [...steps],
    result: (): Result | null => result,
    /** What the model's message was marked with when the API refused it. */
    marked: () => marked,
    /** Lines that were not a JSON object. A count: nothing of them is kept. */
    unread: () => unread,
    /** Goes up whenever the text or the steps change. */
    changes: () => changes,
  };
}

const CUT = "\n[The answer was cut here.]";

/** An answer within the server's limit: a longer one is cut on a whole character and says so. */
export function boundedAnswer(text: string): string {
  if (text.length <= MAX_CHAT_ANSWER_LENGTH) return text;
  let kept = text.slice(0, MAX_CHAT_ANSWER_LENGTH - CUT.length);
  // Not half of a pair.
  if (/[\uD800-\uDBFF]$/.test(kept)) kept = kept.slice(0, -1);
  return `${kept}${CUT}`;
}

const SIGNED_OUT = /\/login|not logged in|auth login|invalid api key|authentication|oauth|unauthorized/i;
const LIMIT = /usage limit|hit your limit|rate limit|limit reached|quota|billing|credit balance/i;

export type Outcome =
  | { ok: true; text: string }
  /** `text` is what the model had written when it ran out of turns, and empty otherwise: never the error's words. */
  | { ok: false; failed: RunnerFailure; text: string };

/** What a finished run comes to: the answer, or which of the closed kinds of failure. */
export function outcomeOf(reader: Reader, exitCode: number | null): Outcome {
  const result = reader.result();
  // Only a run that ran out of turns keeps what it wrote. For any other
  // failure the latest "message" may be the CLI's own words about the error.
  const failed = (kind: RunnerFailure): Outcome => ({
    ok: false,
    failed: kind,
    text: kind === "tooLong" ? reader.text() : "",
  });
  const marked = reader.marked();
  if (marked === "authentication_failed") return failed("notSignedIn");
  if (marked === "rate_limit" || marked === "billing_error") return failed("usageLimit");
  if (result === null) return failed("wrong");
  if (result.subtype === "error_max_turns") return failed("tooLong");
  if (result.isError || result.subtype !== "success" || exitCode !== 0) {
    // The error's words tell the kind, and are used for nothing else.
    const said = result.text ?? "";
    if (result.isError && SIGNED_OUT.test(said)) return failed("notSignedIn");
    if (result.isError && LIMIT.test(said)) return failed("usageLimit");
    return failed("wrong");
  }
  if (result.text === null || result.text.trim() === "") return failed("wrong");
  return { ok: true, text: result.text };
}
