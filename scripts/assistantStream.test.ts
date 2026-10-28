import { describe, expect, test } from "vitest";
import { MAX_CHAT_ANSWER_LENGTH } from "../convex/lib/chatRules";
import { boundedAnswer, createReader, outcomeOf } from "./assistantStream";

// What Claude Code prints with `--output-format stream-json`, one JSON object
// a line. Every line here is made up, in the shapes the CLI uses.

const line = (value: unknown) => `${JSON.stringify(value)}\n`;
const delta = (text: string) =>
  line({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } } });
const start = () => line({ type: "stream_event", event: { type: "message_start", message: { id: "msg" } } });
const toolStart = (id: string, name: string) =>
  line({ type: "stream_event", event: { type: "content_block_start", index: 1, content_block: { type: "tool_use", id, name, input: {} } } });
const assistant = (content: unknown[], extra: Record<string, unknown> = {}) =>
  line({ type: "assistant", message: { role: "assistant", content }, ...extra });
const result = (fields: Record<string, unknown>) => line({ type: "result", ...fields });
const ok = (text: string) => result({ subtype: "success", is_error: false, result: text });

function read(...chunks: string[]) {
  const reader = createReader();
  for (const chunk of chunks) reader.push(chunk);
  reader.end();
  return reader;
}

describe("reading the stream", () => {
  test("text deltas build the answer as it is written", () => {
    const reader = createReader();
    reader.push(start());
    reader.push(delta("Made-up "));
    expect(reader.text()).toBe("Made-up ");
    reader.push(delta("answer."));
    expect(reader.text()).toBe("Made-up answer.");
  });

  test("a line split across chunks is read once it is whole, and a last line with no newline at the end", () => {
    const whole = delta("Made-up answer.");
    const reader = createReader();
    reader.push(start() + whole.slice(0, 20));
    expect(reader.text()).toBe("");
    reader.push(whole.slice(20));
    expect(reader.text()).toBe("Made-up answer.");
    const last = read(ok("Made-up final.").trimEnd());
    expect(last.result()).toMatchObject({ text: "Made-up final." });
  });

  test("each new message of the model starts the text again, so what shows is its latest words", () => {
    const reader = read(start(), delta("Made-up first words."), start(), delta("Made-up second."));
    expect(reader.text()).toBe("Made-up second.");
  });

  test("a tool the model used is a step, by the tool's own name, once", () => {
    const reader = read(
      toolStart("toolu_1", "mcp__startup-os__tasks"),
      assistant([{ type: "tool_use", id: "toolu_1", name: "mcp__startup-os__tasks", input: { company: "us" } }]),
      assistant([{ type: "tool_use", id: "toolu_2", name: "mcp__startup-os__deals", input: {} }]),
      assistant([{ type: "tool_use", id: "toolu_3", name: "mcp__startup-os__tasks", input: {} }]),
    );
    expect(reader.steps()).toEqual(["tasks", "deals", "tasks"]);
  });

  test("a tool that is not one of the chat's is not a step: not a built-in, not another server's, not a forbidden one", () => {
    const reader = read(
      assistant([
        { type: "tool_use", id: "a", name: "Bash", input: { command: "NEVER" } },
        { type: "tool_use", id: "b", name: "mcp__other__tasks", input: {} },
        { type: "tool_use", id: "c", name: "mcp__startup-os__task_create", input: {} },
        { type: "tool_use", id: "d", name: "mcp__startup-os__chat_finish", input: {} },
        { type: "tool_use", id: "e", name: "mcp__startup-os__propose", input: {} },
      ]),
    );
    expect(reader.steps()).toEqual(["propose"]);
  });

  test("without partial messages the whole message's text is taken", () => {
    const reader = read(assistant([{ type: "text", text: "Made-up " }, { type: "text", text: "whole." }]));
    expect(reader.text()).toBe("Made-up whole.");
  });

  test("a message that only uses a tool leaves the text as it was", () => {
    const reader = read(assistant([{ type: "text", text: "Made-up words." }]), assistant([{ type: "tool_use", id: "x", name: "mcp__startup-os__goals" }]));
    expect(reader.text()).toBe("Made-up words.");
  });

  test("garbage, other kinds of line and strange shapes are counted and never thrown on", () => {
    const reader = read(
      "not json at all\n",
      "\n",
      "[1,2,3]\n",
      "null\n",
      line({ type: "system", subtype: "init", tools: ["Bash"] }),
      line({ type: "user", message: { content: [{ type: "tool_result", content: "NEVER SHOWN" }] } }),
      line({ type: "assistant", message: null }),
      line({ type: "assistant", message: { content: "text, not blocks" } }),
      line({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "input_json_delta", partial_json: "{}" } } }),
      line({ type: "stream_event" }),
      line({ type: "result" }),
      delta("Made-up answer."),
    );
    expect(reader.text()).toBe("Made-up answer.");
    expect(reader.steps()).toEqual([]);
    expect(reader.unread()).toBe(3);
  });
});

describe("what became of the answer", () => {
  test("a successful result is the answer", () => {
    const reader = read(start(), delta("Made-up partial"), ok("Made-up final answer."));
    expect(outcomeOf(reader, 0)).toEqual({ ok: true, text: "Made-up final answer." });
  });

  test.each([
    ["no result and a clean exit", [delta("half")], 0, "wrong"],
    ["no result and a failed exit", [], 1, "wrong"],
    ["nothing readable at all", ["garbage\n", "more garbage\n"], 0, "wrong"],
    ["a success with no text", [ok("  ")], 0, "wrong"],
    ["a result that is not text", [result({ subtype: "success", is_error: false, result: { a: 1 } })], 0, "wrong"],
    ["a success and a failed exit", [ok("Made-up answer.")], 1, "wrong"],
    ["an error while running", [result({ subtype: "error_during_execution", is_error: true })], 1, "wrong"],
    ["the turn limit", [result({ subtype: "error_max_turns", is_error: true })], 0, "tooLong"],
    ["not signed in, said in the result", [result({ subtype: "success", is_error: true, result: "Invalid API key · Please run /login" })], 1, "notSignedIn"],
    ["not signed in, said another way", [result({ subtype: "success", is_error: true, result: "Not logged in. Run claude auth login to authenticate." })], 1, "notSignedIn"],
    ["a session that expired", [result({ subtype: "success", is_error: true, result: "OAuth token revoked · Please run /login" })], 1, "notSignedIn"],
    ["not signed in, by the message's own mark", [assistant([{ type: "text", text: "x" }], { error: "authentication_failed" }), result({ subtype: "success", is_error: true, result: "x" })], 1, "notSignedIn"],
    ["the usage limit, said in the result", [result({ subtype: "success", is_error: true, result: "Claude AI usage limit reached|1760000000" })], 1, "usageLimit"],
    ["the usage limit, said another way", [result({ subtype: "success", is_error: true, result: "You've hit your limit · resets 3pm" })], 1, "usageLimit"],
    ["the usage limit, by the message's own mark", [assistant([], { error: "rate_limit" }), result({ subtype: "success", is_error: true, result: "" })], 1, "usageLimit"],
    ["a billing error", [assistant([], { error: "billing_error" })], 1, "usageLimit"],
  ] as const)("%s is a failure of a closed kind", (_name, chunks, code, failed) => {
    expect(outcomeOf(read(...chunks), code)).toMatchObject({ ok: false, failed });
  });

  test("a failure carries no text of the error, nor a last message that may be the CLI's own words about it", () => {
    const reader = read(start(), delta("Invalid API key"), result({ subtype: "success", is_error: true, result: "SECRET error /login sosa_x" }));
    expect(outcomeOf(reader, 1)).toEqual({ ok: false, failed: "notSignedIn", text: "" });
    const turns = read(start(), delta("Made-up half"), result({ subtype: "error_max_turns", is_error: true }));
    expect(outcomeOf(turns, 0)).toEqual({ ok: false, failed: "tooLong", text: "Made-up half" });
  });

  test("an answer too long for the server is cut to fit, on a whole character, and says so", () => {
    // A two-unit character lies across the place the cut falls.
    const room = MAX_CHAT_ANSWER_LENGTH - "\n[The answer was cut here.]".length;
    const long = `${"a".repeat(room - 1)}\u{1F600}${"a".repeat(200)}`;
    const cut = boundedAnswer(long);
    expect(cut.startsWith("a".repeat(room - 1) + "\n")).toBe(true);
    expect(cut.length).toBeLessThanOrEqual(MAX_CHAT_ANSWER_LENGTH);
    expect(cut.endsWith("\n[The answer was cut here.]")).toBe(true);
    expect(cut).not.toMatch(/[\uD800-\uDBFF]$|[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
    expect(boundedAnswer("Made-up short.")).toBe("Made-up short.");
  });
});
