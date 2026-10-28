// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import { BotPlays } from "./bot-plays";

afterEach(cleanup);

describe("BotPlays", () => {
  test("a row a play: worked, failed, pending and the win rate", () => {
    render(
      <BotPlays
        name="Growth Bot"
        plays={[
          { play: "cold email v2", worked: 2, failed: 1, pending: 1, winRate: 2 / 3 },
          { play: "<i>intro</i>", worked: 0, failed: 0, pending: 2, winRate: null },
        ]}
      />,
    );
    const table = screen.getByRole("table", { name: "Growth Bot's plays, last 30 days" });
    const rows = within(table).getAllByRole("row");
    expect(rows).toHaveLength(3);
    expect(rows[1]!.textContent).toContain("cold email v2");
    expect(rows[1]!.textContent).toContain("67%");
    // A play's name is text; nothing decided reads "–".
    expect(rows[2]!.textContent).toContain("<i>intro</i>");
    expect(rows[2]!.textContent).toContain("–");
  });

  test("a bot with no plays shows nothing", () => {
    const { container } = render(<BotPlays name="Research Bot" plays={[]} />);
    expect(container.textContent).toBe("");
    expect(render(<BotPlays name="x" plays={undefined} />).container.textContent).toBe("");
  });
});
