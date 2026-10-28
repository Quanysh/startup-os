// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ActionsHeader,
  DataBody,
  DataCell,
  DataFoot,
  DataHead,
  DataHeader,
  DataRow,
  DataRowHeader,
  DataTable,
} from "./data-table";

afterEach(cleanup);

function Example() {
  return (
    <DataTable caption="People paid">
      <DataHead>
        <DataHeader pinned>Name</DataHeader>
        <DataHeader hideBelow="sm">Title</DataHeader>
        <DataHeader numeric>Pay</DataHeader>
        <ActionsHeader />
      </DataHead>
      <DataBody>
        <DataRow>
          <DataRowHeader pinned>Dana Lee</DataRowHeader>
          <DataCell hideBelow="sm">Engineer</DataCell>
          <DataCell numeric>$5,000.00</DataCell>
          <DataCell actions>
            <button type="button">Edit Dana Lee</button>
          </DataCell>
        </DataRow>
      </DataBody>
      <DataFoot>
        <DataRow plain>
          <DataRowHeader>Total</DataRowHeader>
          <DataCell />
          <DataCell numeric>$5,000.00</DataCell>
          <DataCell />
        </DataRow>
      </DataFoot>
    </DataTable>
  );
}

describe("DataTable", () => {
  it("is a real table named by its caption, hidden from sight by default", () => {
    render(<Example />);
    const table = screen.getByRole("table", { name: "People paid" });
    const caption = table.querySelector("caption");
    expect(caption).not.toBeNull();
    expect(caption!.className).toContain("sr-only");
  });

  it("holds what is positioned inside it, so a hidden header label never widens the page on a phone", () => {
    const { container } = render(<Example />);
    const box = container.querySelector('[data-slot="data-table-box"]')!;
    // An sr-only label is absolutely positioned: without a positioned box it
    // escapes the sideways scroll and the whole page scrolls with it.
    expect(box.className.split(" ")).toContain("relative");
  });

  it("shows the caption when asked to", () => {
    render(
      <DataTable caption="March, paid in USD" showCaption>
        <DataBody>
          <DataRow>
            <DataCell>x</DataCell>
          </DataRow>
        </DataBody>
      </DataTable>,
    );
    expect(screen.getByText("March, paid in USD").className).not.toContain("sr-only");
  });

  it("can be named by a label instead of a caption", () => {
    render(
      <DataTable label="Saved months">
        <DataBody>
          <DataRow>
            <DataCell>x</DataCell>
          </DataRow>
        </DataBody>
      </DataTable>,
    );
    const table = screen.getByRole("table", { name: "Saved months" });
    expect(table.querySelector("caption")).toBeNull();
  });

  it("scrolls sideways inside its own box, never the page", () => {
    render(<Example />);
    const box = screen.getByRole("table").parentElement!;
    expect(box.className).toContain("overflow-x-auto");
  });

  it("names every column with a column header", () => {
    render(<Example />);
    const headers = screen.getAllByRole("columnheader");
    expect(headers.map((th) => th.textContent)).toEqual(["Name", "Title", "Pay", "Actions"]);
    for (const th of headers) expect(th.getAttribute("scope")).toBe("col");
    // The actions column is named for a screen reader and blank to the eye.
    expect(within(headers[3]!).getByText("Actions").className).toContain("sr-only");
  });

  it("gives a row its record as a row header", () => {
    render(<Example />);
    const header = screen.getByRole("rowheader", { name: "Dana Lee" });
    expect(header.getAttribute("scope")).toBe("row");
    const row = header.closest("tr")!;
    expect(within(row).getAllByRole("cell").map((td) => td.textContent)).toEqual([
      "Engineer",
      "$5,000.00",
      "Edit Dana Lee",
    ]);
  });

  it("right-aligns numbers in tabular figures, header and cell alike", () => {
    render(<Example />);
    const head = screen.getByRole("columnheader", { name: "Pay" });
    expect(head.className).toContain("text-right");
    const cell = screen.getAllByRole("cell", { name: "$5,000.00" })[0]!;
    expect(cell.className).toContain("text-right");
    expect(cell.className).toContain("font-num");
  });

  it("pins the first column on a narrow screen only", () => {
    render(<Example />);
    for (const cell of [
      screen.getByRole("columnheader", { name: "Name" }),
      screen.getByRole("rowheader", { name: "Dana Lee" }),
    ]) {
      expect(cell.className).toContain("max-sm:sticky");
      expect(cell.className).toContain("max-sm:left-0");
    }
    expect(screen.getByRole("columnheader", { name: "Pay" }).className).not.toContain("sticky");
  });

  it("hides a lesser column below a breakpoint, header and cell together", () => {
    render(<Example />);
    const head = screen.getByRole("columnheader", { name: "Title" });
    const cell = screen.getByRole("cell", { name: "Engineer" });
    for (const element of [head, cell]) {
      expect(element.className).toContain("hidden");
      expect(element.className).toContain("sm:table-cell");
    }
  });

  it("lights a record under the pointer, and not a header or a plain row", () => {
    render(<Example />);
    // The stylesheet lights `data-row="record"` on hover and on focus within.
    const body = screen.getByRole("rowheader", { name: "Dana Lee" }).closest("tr")!;
    expect(body.dataset.row).toBe("record");
    const head = screen.getByRole("columnheader", { name: "Name" }).closest("tr")!;
    expect(head.dataset.row).toBeUndefined();
    const total = screen.getByRole("rowheader", { name: "Total" }).closest("tr")!;
    expect(total.dataset.row).toBe("plain");
  });

  it("stripes every second record by default, and by group or not at all when asked", () => {
    render(
      <DataTable label="Stripes">
        <DataBody>
          <DataRow>
            <DataCell>a</DataCell>
          </DataRow>
        </DataBody>
        <DataBody stripe="groups">
          <DataRow>
            <DataCell>b</DataCell>
          </DataRow>
        </DataBody>
        <DataBody stripe="none">
          <DataRow>
            <DataCell>c</DataCell>
          </DataRow>
        </DataBody>
      </DataTable>,
    );
    const bodies = screen.getByRole("table").querySelectorAll("tbody");
    expect([...bodies].map((body) => body.dataset.stripe)).toEqual(["rows", "groups", "none"]);
  });

  it("reads the header as a header: its own ink, on a band the stylesheet draws", () => {
    render(<Example />);
    const head = screen.getByRole("columnheader", { name: "Pay" });
    expect(head.className).toContain("text-table-head-ink");
    expect(head.closest("thead")!.dataset.slot).toBe("data-head");
  });

  it("starts each row with its name in ink at medium weight", () => {
    render(<Example />);
    const name = screen.getByRole("rowheader", { name: "Dana Lee" });
    expect(name.className).toContain("font-medium");
    expect(name.className).toContain("text-ink");
  });

  it("marks a row that needs attention, and no other", () => {
    render(
      <DataTable label="Tones">
        <DataBody>
          <DataRow tone="danger">
            <DataCell>late</DataCell>
          </DataRow>
          <DataRow tone="warning">
            <DataCell>short</DataCell>
          </DataRow>
          <DataRow>
            <DataCell>fine</DataCell>
          </DataRow>
        </DataBody>
      </DataTable>,
    );
    const tone = (text: string) => screen.getByRole("cell", { name: text }).closest("tr")!.dataset.tone;
    expect(tone("late")).toBe("danger");
    expect(tone("short")).toBe("warning");
    expect(tone("fine")).toBeUndefined();
  });

  it("gives a group of columns one hue, header and cell together, and can stress one", () => {
    render(
      <DataTable label="Groups">
        <DataHead>
          <DataHeader>Person</DataHeader>
          <DataHeader numeric group="teal">
            Gross
          </DataHeader>
          <DataHeader numeric group="teal" strong>
            Net
          </DataHeader>
          <DataHeader numeric group="violet" strong>
            Cost
          </DataHeader>
        </DataHead>
        <DataBody>
          <DataRow>
            <DataCell>Dana</DataCell>
            <DataCell numeric group="teal">
              10
            </DataCell>
            <DataCell numeric group="teal" strong>
              8
            </DataCell>
            <DataCell numeric group="violet" strong>
              12
            </DataCell>
          </DataRow>
        </DataBody>
      </DataTable>,
    );
    const marks = (el: HTMLElement) => [el.dataset.group, el.dataset.strong !== undefined];
    expect(marks(screen.getByRole("columnheader", { name: "Person" }))).toEqual([undefined, false]);
    expect(marks(screen.getByRole("columnheader", { name: "Gross" }))).toEqual(["teal", false]);
    expect(marks(screen.getByRole("columnheader", { name: "Net" }))).toEqual(["teal", true]);
    expect(marks(screen.getByRole("columnheader", { name: "Cost" }))).toEqual(["violet", true]);
    expect(marks(screen.getByRole("cell", { name: "10" }))).toEqual(["teal", false]);
    expect(marks(screen.getByRole("cell", { name: "8" }))).toEqual(["teal", true]);
    expect(marks(screen.getByRole("cell", { name: "12" }))).toEqual(["violet", true]);
    expect(screen.getByRole("cell", { name: "8" }).className).toContain("font-semibold");
    expect(screen.getByRole("columnheader", { name: "Net" }).className).toContain("font-semibold");
  });

  it("gives a pinned cell its row's ground, so a stripe or a tint does not show through", () => {
    render(<Example />);
    expect(screen.getByRole("rowheader", { name: "Dana Lee" }).className).toContain("--row-bg");
  });

  it("sets totals apart: heavier, in a footer the stylesheet bands", () => {
    render(<Example />);
    const foot = screen.getByRole("rowheader", { name: "Total" }).closest("tfoot")!;
    expect(foot.dataset.slot).toBe("data-foot");
    expect(foot.className).toContain("font-medium");
  });

  it("keeps a footer in the table", () => {
    render(<Example />);
    const total = screen.getByRole("rowheader", { name: "Total" });
    expect(total.closest("tfoot")).not.toBeNull();
  });
});

describe("DataTable: download as CSV", () => {
  let saved: { name: string; blob: Blob }[];

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 9, 15, 9, 30));
    saved = [];
    let blob: Blob | null = null;
    URL.createObjectURL = vi.fn((b: Blob) => {
      blob = b;
      return "blob:startup/table";
    });
    URL.revokeObjectURL = vi.fn();
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
      saved.push({ name: this.download, blob: blob! });
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  // The file's text, byte-order mark and all (readAsText would drop the mark).
  const textOf = (blob: Blob) =>
    new Promise<string>((resolve) => {
      const reader = new FileReader();
      reader.onload = () =>
        resolve(new TextDecoder("utf-8", { ignoreBOM: true }).decode(reader.result as ArrayBuffer));
      reader.readAsArrayBuffer(blob);
    });

  it("offers a quiet CSV button by the table, outside it, named for the table", () => {
    render(<Example />);
    const button = screen.getByRole("button", { name: "Download People paid as CSV" });
    expect(button.textContent).toBe("CSV");
    expect(screen.getByRole("table").contains(button)).toBe(false);
  });

  it("saves what the table shows: header, rows and totals, the actions column left out", async () => {
    render(<Example />);
    fireEvent.click(screen.getByRole("button", { name: "Download People paid as CSV" }));
    expect(saved.map(({ name }) => name)).toEqual(["people-paid-2026-10-15.csv"]);
    // The title column is hidden on a phone only, so it is in the file.
    expect(await textOf(saved[0]!.blob)).toBe(
      '﻿Name,Title,Pay\r\nDana Lee,Engineer,"$5,000.00"\r\nTotal,,"$5,000.00"\r\n',
    );
  });

  it("is named by the label, or by the name it is given", () => {
    const { unmount } = render(
      <DataTable label="Saved months">
        <DataBody>
          <DataRow>
            <DataCell>x</DataCell>
          </DataRow>
        </DataBody>
      </DataTable>,
    );
    expect(screen.getByRole("button", { name: "Download Saved months as CSV" })).toBeDefined();
    unmount();
    render(
      <DataTable caption="Monthly costs by category" download="All costs">
        <DataBody>
          <DataRow>
            <DataCell>x</DataCell>
          </DataRow>
        </DataBody>
      </DataTable>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Download All costs as CSV" }));
    expect(saved[0]!.name).toBe("all-costs-2026-10-15.csv");
  });

  it("offers nothing where a download makes no sense", () => {
    render(
      <DataTable label="Targets" download={false}>
        <DataBody>
          <DataRow>
            <DataCell>x</DataCell>
          </DataRow>
        </DataBody>
      </DataTable>,
    );
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("writes a cell's export value in place of what it shows, and leaves out a column marked noExport", async () => {
    render(
      <DataTable label="Targets">
        <DataHead>
          <DataHeader>Number</DataHeader>
          <DataHeader numeric>Target</DataHeader>
          <DataHeader noExport>New target</DataHeader>
        </DataHead>
        <DataBody>
          <DataRow>
            <DataRowHeader>MRR</DataRowHeader>
            <DataCell numeric exportValue="1075">
              $1,075.00
            </DataCell>
            <DataCell>
              <input aria-label="New target for MRR" defaultValue="2000" />
            </DataCell>
          </DataRow>
        </DataBody>
      </DataTable>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Download Targets as CSV" }));
    expect(await textOf(saved[0]!.blob)).toBe("﻿Number,Target\r\nMRR,1075\r\n");
  });

  it("keeps the box's margins on the whole, and the table's own box as it was", () => {
    render(
      <DataTable label="Boxed" boxClassName="mt-2">
        <DataBody>
          <DataRow>
            <DataCell>x</DataCell>
          </DataRow>
        </DataBody>
      </DataTable>,
    );
    const box = screen.getByRole("table").parentElement!;
    expect(box.dataset.slot).toBe("data-table-box");
    expect(box.className).toContain("-mx-3");
    expect(box.className).not.toContain("mt-2");
    expect(box.parentElement!.className).toContain("mt-2");
    // In a flex or grid parent the whole may shrink, so a wide table scrolls in its box
    // (as it did when the box was the outermost element) instead of widening the page.
    expect(box.parentElement!.className).toContain("min-w-0");
  });

  it("downloads only its own table when one table is opened inside another's row", async () => {
    render(
      <DataTable label="Month">
        <DataHead>
          <DataHeader>Person</DataHeader>
          <DataHeader numeric>Net</DataHeader>
        </DataHead>
        <DataBody>
          <DataRow>
            <DataRowHeader>Dana Lee</DataRowHeader>
            <DataCell numeric>$5.00</DataCell>
          </DataRow>
          <DataRow plain>
            <DataCell colSpan={2}>
              <DataTable caption="Lines for Dana Lee" on="surface">
                <DataBody>
                  <DataRow plain>
                    <DataRowHeader>Income tax</DataRowHeader>
                    <DataCell numeric>$1.00</DataCell>
                  </DataRow>
                </DataBody>
              </DataTable>
            </DataCell>
          </DataRow>
        </DataBody>
      </DataTable>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Download Month as CSV" }));
    fireEvent.click(screen.getByRole("button", { name: "Download Lines for Dana Lee as CSV" }));
    expect(saved.map(({ name }) => name)).toEqual(["month-2026-10-15.csv", "lines-for-dana-lee-2026-10-15.csv"]);
    expect(await textOf(saved[0]!.blob)).toBe("﻿Person,Net\r\nDana Lee,$5.00\r\n");
    expect(await textOf(saved[1]!.blob)).toBe("﻿Income tax,$1.00\r\n");
  });
});

describe("a column of words is never crushed to a word a line", () => {
  it("a text cell, its header and a row's name keep a floor width; a number, a button column and a narrow column do not", () => {
    render(
      <DataTable label="Cost lines">
        <DataHead>
          <DataHeader>Name</DataHeader>
          <DataHeader>Note</DataHeader>
          <DataHeader narrow>On</DataHeader>
          <DataHeader numeric>Amount</DataHeader>
          <ActionsHeader />
        </DataHead>
        <DataBody>
          <DataRow>
            <DataRowHeader>Sample hosting</DataRowHeader>
            <DataCell>Made-up: usage moves with traffic.</DataCell>
            <DataCell narrow>Yes</DataCell>
            <DataCell numeric>$1,840</DataCell>
            <DataCell actions>
              <button type="button">Edit</button>
            </DataCell>
          </DataRow>
        </DataBody>
      </DataTable>,
    );
    const floor = (el: Element) => /\bmin-w-\[/.test(el.className);
    expect(floor(screen.getByRole("columnheader", { name: "Note" }))).toBe(true);
    expect(floor(screen.getByText("Made-up: usage moves with traffic."))).toBe(true);
    expect(floor(screen.getByRole("rowheader", { name: "Sample hosting" }))).toBe(true);
    expect(floor(screen.getByText("Yes"))).toBe(false);
    expect(floor(screen.getByRole("columnheader", { name: "On" }))).toBe(false);
    expect(floor(screen.getByText("$1,840"))).toBe(false);
    expect(floor(screen.getByRole("button", { name: "Edit" }).closest("td")!)).toBe(false);
  });
});
