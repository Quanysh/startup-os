// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import { Masonry } from "./masonry";

afterEach(() => cleanup());

test("with nothing measured yet (or one column), the panels are a plain stack in their own order", () => {
  render(
    <Masonry minColumnWidth={440} maxColumns={2}>
      <section>First</section>
      <section>Second</section>
      {false}
    </Masonry>,
  );
  const box = document.querySelector("[data-slot=masonry]")!;
  expect(box.className).toContain("flex-col");
  expect([...box.children].map((cell) => cell.textContent)).toEqual(["First", "Second"]);
  expect(screen.getByText("First").parentElement!.getAttribute("style")).toBeNull();
});
