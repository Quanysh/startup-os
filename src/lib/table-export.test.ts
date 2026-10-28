// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { downloadCsv, readTable } from "./table-export";

function table(html: string): HTMLTableElement {
  document.body.innerHTML = `<table>${html}</table>`;
  return document.querySelector("table")!;
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("readTable: rows", () => {
  it("reads the header, every body and the footer, in that order", () => {
    const t = table(`
      <thead><tr><th>Name</th><th>Pay</th></tr></thead>
      <tbody><tr><th scope="row">Dana Lee</th><td>$5,000.00</td></tr></tbody>
      <tbody><tr><th scope="row">Sam Kim</th><td>$4,000.00</td></tr></tbody>
      <tfoot><tr><th scope="row">Total</th><td>$9,000.00</td></tr></tfoot>`);
    expect(readTable(t)).toEqual([
      ["Name", "Pay"],
      ["Dana Lee", "$5,000.00"],
      ["Sam Kim", "$4,000.00"],
      ["Total", "$9,000.00"],
    ]);
  });

  it("leaves out a row marked data-export-skip", () => {
    const t = table(`
      <tbody><tr><td>kept</td></tr><tr data-export-skip><td>not this</td></tr></tbody>`);
    expect(readTable(t)).toEqual([["kept"]]);
  });

  it("leaves out a row that is one cell across the whole table (an editor, a breakdown, a note)", () => {
    const t = table(`
      <thead><tr><th>Name</th><th>Role</th><th>Pay</th></tr></thead>
      <tbody>
        <tr><td>Dana</td><td>Engineer</td><td>$5</td></tr>
        <tr><td colspan="3"><form><input value="Dana"></form></td></tr>
        <tr><td>Payroll</td><td colspan="2">On the Payroll page</td></tr>
      </tbody>`);
    expect(readTable(t)).toEqual([
      ["Name", "Role", "Pay"],
      ["Dana", "Engineer", "$5"],
      ["Payroll", "On the Payroll page", ""],
    ]);
  });

  it("gives a spanned cell its value once and blanks for the columns it covers", () => {
    const t = table(`
      <thead><tr><th>A</th><th>B</th><th>C</th><th>D</th></tr></thead>
      <tfoot><tr><th>Total</th><td colspan="2">note</td><td>$1</td></tr></tfoot>`);
    expect(readTable(t)[1]).toEqual(["Total", "note", "", "$1"]);
  });

  it("reads a table only", () => {
    document.body.innerHTML = "<div>not a table</div>";
    expect(() => readTable(document.querySelector("div")!)).toThrow("readTable reads a <table>, not a <div>.");
  });

  it("does not read a table nested in a cell: it has its own download", () => {
    const t = table(`
      <tbody><tr><td>Dana</td><td>shown <table><tbody><tr><td>inner</td></tr></tbody></table></td></tr></tbody>`);
    expect(readTable(t)).toEqual([["Dana", "shown"]]);
  });
});

describe("readTable: columns", () => {
  it("leaves out a column whose header is marked, in every row", () => {
    const t = table(`
      <thead><tr><th>Name</th><th>Pay</th><th data-export-skip><span class="sr-only">Actions</span></th></tr></thead>
      <tbody><tr><td>Dana</td><td>$5</td><td data-export-skip><button>Edit</button></td></tr></tbody>
      <tfoot><tr><td>Total</td><td>$5</td><td></td></tr></tfoot>`);
    expect(readTable(t)).toEqual([
      ["Name", "Pay"],
      ["Dana", "$5"],
      ["Total", "$5"],
    ]);
  });

  it("blanks a marked cell in a column that is kept, so the columns stay in line", () => {
    const t = table(`
      <thead><tr><th>Name</th><th>Note</th><th>Pay</th></tr></thead>
      <tbody><tr><td>Dana</td><td data-export-skip><button>Write</button></td><td>$5</td></tr></tbody>`);
    expect(readTable(t)[1]).toEqual(["Dana", "", "$5"]);
  });

  it("with no header row, leaves out a column whose every cell is marked", () => {
    const t = table(`
      <tbody>
        <tr><td>Oct 2026</td><td>$5</td><td data-export-skip><button>Remove</button></td></tr>
        <tr><td>Sep 2026</td><td>$4</td><td data-export-skip></td></tr>
      </tbody>`);
    expect(readTable(t)).toEqual([
      ["Oct 2026", "$5"],
      ["Sep 2026", "$4"],
    ]);
  });

  it("reads a column hidden below a breakpoint: only the class hides it", () => {
    const t = table(`
      <thead><tr><th>Name</th><th class="hidden sm:table-cell">Title</th></tr></thead>
      <tbody><tr><td>Dana</td><td class="hidden sm:table-cell">Engineer</td></tr></tbody>`);
    expect(readTable(t)).toEqual([
      ["Name", "Title"],
      ["Dana", "Engineer"],
    ]);
  });
});

describe("readTable: a cell's text", () => {
  const cell = (html: string) => readTable(table(`<tbody><tr><td>${html}</td></tr></tbody>`))[0]![0];

  it("collapses whitespace", () => {
    expect(cell("  Dana \n   Lee  ")).toBe("Dana Lee");
  });

  it("joins parts shown on separate lines with a space", () => {
    expect(cell('₸250,000<span class="block text-xs">≈ $500.00</span>')).toBe("₸250,000 ≈ $500.00");
    expect(cell("<div>one</div><div>two</div>")).toBe("one two");
    expect(cell("<p>one</p><p>two</p>")).toBe("one two");
    expect(cell("one<br>two")).toBe("one two");
  });

  it("joins items laid out apart (flex, grid, inline-flex chips) with a space", () => {
    expect(cell('<span class="flex gap-2"><span class="inline-flex">Paid</span><span class="inline-flex">Late</span></span>')).toBe(
      "Paid Late",
    );
    // A flex or grid container's items sit apart whatever they are.
    expect(cell('<div class="flex flex-wrap gap-1"><span class="rounded-full">Today</span><span>Board</span></div>')).toBe(
      "Today Board",
    );
    expect(cell('<span class="grid">₸1<span>≈ $2</span></span>')).toBe("₸1 ≈ $2");
  });

  it("keeps inline pieces together", () => {
    expect(cell("<span>₸</span><span>250,000</span>")).toBe("₸250,000");
    expect(cell("Paid on <b>3 Oct</b>")).toBe("Paid on 3 Oct");
  });

  it("leaves out words for a screen reader only", () => {
    expect(cell('<button><span class="sr-only">Breakdown for </span><span>Dana Lee</span></button>')).toBe("Dana Lee");
  });

  it("keeps a screen-reader separator, so a list still reads as one", () => {
    expect(
      cell('<span class="inline-flex">Startup</span><span class="sr-only">, </span><span class="inline-flex">Globex</span>'),
    ).toBe("Startup, Globex");
  });

  it("keeps what is shown but hidden from a screen reader", () => {
    expect(cell('<span aria-hidden="true">≈ </span><span class="sr-only">about </span>$500.00')).toBe("≈ $500.00");
  });

  it("reads a sort button in a header as its label alone", () => {
    const t = table(`<thead><tr><th aria-sort="ascending"><button>Due<svg aria-hidden="true"><title>arrow</title></svg></button></th></tr></thead>`);
    expect(readTable(t)).toEqual([["Due"]]);
  });

  it("leaves out an element marked data-export-skip, an alert and anything hidden", () => {
    expect(cell('Linked 2026-10-01 <button data-export-skip>Reset link</button>')).toBe("Linked 2026-10-01");
    expect(cell('$5<p role="alert">The save failed.</p>')).toBe("$5");
    expect(cell("$5<span hidden>secret</span>")).toBe("$5");
  });

  it("takes data-export in place of what an element shows", () => {
    expect(readTable(table('<tbody><tr><td data-export="1075">$1,075.00</td></tr></tbody>'))[0]![0]).toBe("1075");
    expect(cell('<span data-export="Overdue">!</span> 3 Oct')).toBe("Overdue 3 Oct");
  });

  it("reads a field's value, a menu's choice, and no checkbox", () => {
    expect(cell('<input value="1500.00">')).toBe("1500.00");
    expect(cell("<textarea>a note</textarea>")).toBe("a note");
    expect(cell('<select><option value="a">One</option><option value="b" selected>Two</option></select>')).toBe("Two");
    expect(cell('<input type="checkbox" checked aria-label="Select"><button>Write the brief</button>')).toBe(
      "Write the brief",
    );
    expect(cell('<input type="hidden" value="id-1">x')).toBe("x");
  });
});

describe("downloadCsv", () => {
  let created: Blob[];
  let clicked: { href: string; download: string; attached: boolean }[];

  beforeEach(() => {
    vi.useFakeTimers();
    created = [];
    clicked = [];
    URL.createObjectURL = vi.fn((blob: Blob) => {
      created.push(blob);
      return "blob:startup/1";
    });
    URL.revokeObjectURL = vi.fn();
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
      clicked.push({ href: this.href, download: this.download, attached: document.body.contains(this) });
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("saves the text as a UTF-8 CSV under the name, through a link it takes away again", async () => {
    downloadCsv("people-2026-10-15.csv", "﻿Name\r\n");
    expect(clicked).toEqual([{ href: "blob:startup/1", download: "people-2026-10-15.csv", attached: true }]);
    expect(document.querySelector("a")).toBeNull();
    expect(created[0]!.type).toBe("text/csv;charset=utf-8");
    // jsdom's Blob has no arrayBuffer(); FileReader reads the same bytes, on real timers.
    vi.useRealTimers();
    const bytes = await new Promise<Uint8Array>((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer));
      reader.readAsArrayBuffer(created[0]!);
    });
    expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
  });

  it("revokes the address once the browser has had it", () => {
    downloadCsv("people-2026-10-15.csv", "x");
    expect(URL.revokeObjectURL).not.toHaveBeenCalled();
    vi.runAllTimers();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:startup/1");
  });
});
