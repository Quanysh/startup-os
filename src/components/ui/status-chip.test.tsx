// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { KeyRoundIcon } from "lucide-react";
import { afterEach, describe, expect, it } from "vitest";
import {
  KIND_TONES,
  KindTag,
  STATUS_INK,
  STATUS_TONES,
  StatusChip,
  StatusMark,
} from "./status-chip";

afterEach(cleanup);

const css = readFileSync(resolve(process.cwd(), "src/styles/globals.css"), "utf8");
const token = (name: string) => new RegExp(`--color-${name}:\\s*#[0-9a-f]{6};`).exec(css)?.[0];

describe("StatusChip", () => {
  it.each(STATUS_TONES)("%s: its words, an icon, and that tone's ground and ink", (tone) => {
    render(<StatusChip tone={tone}>Word for {tone}</StatusChip>);
    const chip = screen.getByText(`Word for ${tone}`);
    expect(chip.dataset.tone).toBe(tone);
    expect(chip.className).toContain(`bg-${tone}-soft`);
    expect(chip.className).toContain(`text-${tone}-ink`);
    // Never colour alone: the words are there, and an icon the reader need not hear.
    const icon = chip.querySelector("svg");
    expect(icon).not.toBeNull();
    expect(icon!.getAttribute("aria-hidden")).toBe("true");
  });

  it("gives every tone a different look", () => {
    const looks = STATUS_TONES.map((tone) => {
      const { container } = render(<StatusChip tone={tone}>x</StatusChip>);
      return container.firstElementChild!.className;
    });
    expect(new Set(looks).size).toBe(STATUS_TONES.length);
  });

  it("gives every tone an icon of its own, so tones differ without colour", () => {
    const icons = STATUS_TONES.map((tone) => {
      const { container } = render(<StatusChip tone={tone}>x</StatusChip>);
      return container.querySelector("svg")!.innerHTML;
    });
    expect(new Set(icons).size).toBe(STATUS_TONES.length);
  });

  it("takes another icon where one says it better", () => {
    const { container: plain } = render(<StatusChip tone="warning">a</StatusChip>);
    const { container: keyed } = render(
      <StatusChip tone="warning" icon={KeyRoundIcon}>
        b
      </StatusChip>,
    );
    expect(keyed.querySelector("svg")!.innerHTML).not.toBe(plain.querySelector("svg")!.innerHTML);
  });

  it.each(STATUS_TONES)("%s outlined: the same ink and no ground", (tone) => {
    render(
      <StatusChip tone={tone} variant="outline">
        Lesser
      </StatusChip>,
    );
    const chip = screen.getByText("Lesser");
    expect(chip.dataset.variant).toBe("outline");
    expect(chip.className).toContain(`text-${tone}-ink`);
    expect(chip.className).toContain(`border-${tone}-ink`);
    expect(chip.className).not.toContain(`bg-${tone}-soft`);
  });

  it.each(STATUS_TONES)("%s: both of its colours are tokens in globals.css", (tone) => {
    expect(token(`${tone}-soft`)).toBeDefined();
    expect(token(`${tone}-ink`)).toBeDefined();
    expect(STATUS_INK[tone]).toBe(`text-${tone}-ink`);
  });
});

describe("StatusMark", () => {
  it.each(STATUS_TONES)("%s: a hidden icon in the tone's ink", (tone) => {
    const { container } = render(<StatusMark tone={tone} />);
    const icon = container.querySelector("svg")!;
    expect(icon.getAttribute("aria-hidden")).toBe("true");
    expect(icon.getAttribute("class")).toContain(`text-${tone}-ink`);
  });
});

describe("KindTag", () => {
  it.each(KIND_TONES)("%s: its word, a dot, and that hue's ground and ink", (tone) => {
    render(<KindTag tone={tone}>Kind {tone}</KindTag>);
    const tag = screen.getByText(`Kind ${tone}`);
    expect(tag.dataset.tone).toBe(tone);
    expect(tag.className).toContain(`bg-kind-${tone}-soft`);
    expect(tag.className).toContain(`text-kind-${tone}-ink`);
    const dot = tag.querySelector("span")!;
    expect(dot.getAttribute("aria-hidden")).toBe("true");
    expect(dot.className).toContain(`bg-kind-${tone}`);
  });

  it("gives every hue a different look, and every hue three tokens", () => {
    const looks = KIND_TONES.map((tone) => {
      const { container } = render(<KindTag tone={tone}>x</KindTag>);
      return container.firstElementChild!.className;
    });
    expect(new Set(looks).size).toBe(KIND_TONES.length);
    const values = KIND_TONES.map((tone) => token(`kind-${tone}`));
    expect(values.every((value) => value !== undefined)).toBe(true);
    expect(new Set(values.map((value) => value!.split(":")[1])).size).toBe(KIND_TONES.length);
    for (const tone of KIND_TONES) {
      expect(token(`kind-${tone}-soft`)).toBeDefined();
      expect(token(`kind-${tone}-ink`)).toBeDefined();
    }
  });

  it("is quieter than a state: regular weight, where a status chip is medium", () => {
    render(
      <>
        <StatusChip tone="danger">Overdue</StatusChip>
        <KindTag tone="teal">Employee</KindTag>
      </>,
    );
    expect(screen.getByText("Overdue").className).toContain("font-medium");
    expect(screen.getByText("Employee").className).toContain("font-normal");
    expect(screen.getByText("Employee").className).not.toContain("font-medium");
  });
});
