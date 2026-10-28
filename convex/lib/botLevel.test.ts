import { describe, expect, test } from "vitest";
import { BOT_PERMISSION_WORDS, BOT_WORDS, botAreaRefusal, botLevelRefusal, cleanPermissions } from "./botRules";

// One rule for giving a bot a level on an area: the Bots tab's Grant, an
// approved `permission_request`, the shaping of that request and the Bots
// tab's own permission editor all ask it.
describe("a bot's level on an area", () => {
  test("a locked area, then an area no bot holds, then whether it is on, then whether it holds it already", () => {
    const bot = { enabled: true, permissions: [{ area: "sales" as const, level: "read" as const }] };
    expect(botAreaRefusal("costs")).toBe("locked");
    expect(botAreaRefusal("marketing")).toBe("notBotArea");
    expect(botAreaRefusal("sales")).toBeNull();
    expect(botLevelRefusal(bot, "payroll", "read")).toBe(BOT_WORDS.locked);
    expect(botLevelRefusal(bot, "nonsense", "read")).toBe(BOT_PERMISSION_WORDS.badArea);
    expect(botLevelRefusal({ ...bot, enabled: false }, "sales", "write")).toBe(BOT_WORDS.off);
    expect(botLevelRefusal(bot, "sales", "read")).toBe(BOT_PERMISSION_WORDS.held);
    expect(botLevelRefusal(bot, "sales", "write")).toBeNull();
  });

  test("the permission editor refuses a locked area in the same words", () => {
    expect(() => cleanPermissions([{ area: "costs", level: "read" }])).toThrow(BOT_WORDS.locked);
  });
});
