import { describe, expect, test } from "vitest";
import { agentTaskOrigin } from "./taskOrigin";

describe("agentTaskOrigin", () => {
  test("records a bot's profile id and one of the four, and leaves a name that is not a profile off", () => {
    expect(agentTaskOrigin({ bot: "growth" })).toEqual({ source: "agent", bot: "growth" });
    expect(agentTaskOrigin({ agent: "finance" })).toEqual({ source: "agent", agent: "finance" });
    expect(agentTaskOrigin({ agent: "chief_of_staff", bot: "growth" })).toEqual({
      source: "agent",
      agent: "chief_of_staff",
      bot: "growth",
    });
    // An external owner-agent profile is a bot of that id.
    expect(agentTaskOrigin({ bot: "chief_of_staff" })).toEqual({ source: "agent", bot: "chief_of_staff" });
    // Capitals, a too-short name, and one of the four that has no profile (sales) are not a bot.
    expect(agentTaskOrigin({ bot: "Growth" })).toEqual({ source: "agent" });
    expect(agentTaskOrigin({ bot: "x" })).toEqual({ source: "agent" });
    expect(agentTaskOrigin({ bot: "sales", agent: "sales" })).toEqual({ source: "agent", agent: "sales" });
    expect(agentTaskOrigin({})).toEqual({ source: "agent" });
  });
});
