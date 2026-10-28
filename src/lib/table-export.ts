import { csvFileName, toCsv } from "./csv";

/**
 * A table on the screen as rows of text, and the file the browser saves.
 *
 * The rows are read from the rendered table, never asked of the server, so a
 * download holds exactly what the viewer is shown and can never widen what
 * they may see: a row that is not rendered (a folded group, a filtered-out
 * record) is not in it. A column hidden only below a breakpoint is rendered,
 * so it is.
 *
 * What is read, and what is not:
 * - Rows: the header, every body, then the footer. A row marked
 *   `data-export-skip` is left out, and so is a row that is one cell across
 *   the whole table: an editor, a breakdown or a note opened under a record.
 * - Columns: a column whose header cell is marked `data-export-skip` (every
 *   `ActionsHeader`) is left out of every row. With no header row, a column
 *   whose every cell is marked is. A marked cell in a kept column is blank. A
 *   spanned cell gives its text once and a blank for each column it covers.
 * - A cell's text: what it shows, whitespace collapsed, with a space where
 *   parts sit apart (a block, a line break, flex or grid items, a chip).
 *   Words for a screen reader only (`sr-only`) are left out, unless they are
 *   only a separator (", "); so are an element marked `data-export-skip`, an
 *   alert, anything `hidden`, an icon and a table nested inside. A field
 *   gives its value and a menu its choice; a checkbox gives nothing (it
 *   selects a row). `data-export="…"` on a cell or anything in it is written
 *   in place of what it shows.
 */

const SKIP = "data-export-skip";
const VALUE = "data-export";

/** Elements that sit on lines of their own, or are boxes of their own. */
const APART_TAGS = new Set([
  "address", "article", "aside", "blockquote", "br", "dd", "div", "dl", "dt", "fieldset",
  "figcaption", "figure", "footer", "form", "h1", "h2", "h3", "h4", "h5", "h6", "header",
  "hr", "input", "li", "ol", "p", "pre", "section", "select", "textarea", "ul",
]);

/** Tailwind display classes that set an element apart from its neighbours. */
const APART_CLASSES = new Set([
  "block", "flex", "inline-flex", "grid", "inline-grid", "inline-block", "table", "list-item", "flow-root",
]);

/** Containers whose every item is laid out apart from the next. */
const ITEM_CLASSES = new Set(["flex", "inline-flex", "grid", "inline-grid"]);

const hasClassIn = (element: Element, classes: ReadonlySet<string>) =>
  Array.from(element.classList).some((token) => classes.has(token));

/** Never read: drawn, not written, or a table with a download of its own. */
const UNREAD_TAGS = new Set(["noscript", "script", "style", "svg", "table", "template"]);

/** Inputs that hold no value worth a column. */
const VALUELESS_INPUTS = new Set(["button", "checkbox", "file", "hidden", "image", "password", "radio", "reset", "submit"]);

const isSeparator = (text: string) => /^[\s\p{P}]*$/u.test(text);

function unread(element: Element): boolean {
  return (
    element.hasAttribute(SKIP) ||
    element.hasAttribute("hidden") ||
    element.getAttribute("role") === "alert" ||
    UNREAD_TAGS.has(element.localName) ||
    (element.classList.contains("sr-only") && !isSeparator(element.textContent ?? ""))
  );
}

const apart = (element: Element) => APART_TAGS.has(element.localName) || hasClassIn(element, APART_CLASSES);

/** A form control's value as it is shown; null for anything else. */
function fieldValue(element: Element): string | null {
  switch (element.localName) {
    case "input": {
      const input = element as HTMLInputElement;
      return VALUELESS_INPUTS.has(input.type) ? "" : input.value;
    }
    case "textarea":
      return (element as HTMLTextAreaElement).value;
    case "select":
      return Array.from((element as HTMLSelectElement).selectedOptions, (option) => option.text).join(", ");
    default:
      return null;
  }
}

function collect(parent: Element, out: string[]): void {
  const items = hasClassIn(parent, ITEM_CLASSES);
  for (const child of Array.from(parent.childNodes)) {
    if (child.nodeType === Node.TEXT_NODE) {
      out.push(items ? ` ${child.textContent ?? ""} ` : (child.textContent ?? ""));
      continue;
    }
    if (child.nodeType !== Node.ELEMENT_NODE) continue;
    const element = child as Element;
    if (unread(element)) continue;
    const spaced = items || apart(element);
    if (spaced) out.push(" ");
    const value = element.getAttribute(VALUE) ?? fieldValue(element);
    if (value !== null) out.push(value);
    else collect(element, out);
    if (spaced) out.push(" ");
  }
}

/** A cell's text as it reads on the screen. */
function textOf(cell: HTMLTableCellElement): string {
  const own = cell.getAttribute(VALUE);
  if (own !== null) return own;
  const out: string[] = [];
  collect(cell, out);
  return out
    .join("")
    .replace(/\s+/g, " ")
    .replace(/ ([,;])/g, "$1")
    .trim();
}

type Slot = { text: string; skip: boolean };

/** The table as rows of text, as described above. Takes any element (as a query hands it over) that is a table. */
export function readTable(element: HTMLElement): string[][] {
  if (element.localName !== "table") {
    throw new Error(`readTable reads a <table>, not a <${element.localName}>.`);
  }
  const table = element as HTMLTableElement;
  const head = table.tHead;
  const headWidth = Array.from(head?.rows[0]?.cells ?? [], (cell) => Math.max(1, cell.colSpan)).reduce(
    (sum, span) => sum + span,
    0,
  );

  const grid: { inHead: boolean; slots: Slot[] }[] = [];
  for (const row of Array.from(table.rows)) {
    if (row.hasAttribute(SKIP)) continue;
    const inHead = head !== null && row.parentElement === head;
    const cells = Array.from(row.cells);
    if (!inHead && headWidth > 0 && cells.length === 1 && cells[0]!.colSpan >= headWidth) continue;
    const slots: Slot[] = [];
    for (const cell of cells) {
      const skip = cell.hasAttribute(SKIP);
      const text = skip ? "" : textOf(cell);
      for (let i = 0; i < Math.max(1, cell.colSpan); i++) slots.push({ text: i === 0 ? text : "", skip });
    }
    grid.push({ inHead, slots });
  }

  const width = Math.max(0, ...grid.map(({ slots }) => slots.length));
  const headRows = grid.filter(({ inHead }) => inHead);
  const dropped = new Set<number>();
  for (let column = 0; column < width; column++) {
    const marked =
      headRows.length > 0
        ? headRows.some(({ slots }) => slots[column]?.skip === true)
        : grid.every(({ slots }) => slots[column]?.skip ?? true);
    if (marked) dropped.add(column);
  }

  return grid.map(({ slots }) => slots.filter((_, column) => !dropped.has(column)).map(({ text }) => text));
}

/** Long enough for any browser to have read the file before its address goes. */
const REVOKE_AFTER_MS = 10_000;

/** Has the browser save `csv` as `fileName`, through a link it takes away again. */
export function downloadCsv(fileName: string, csv: string): void {
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  link.hidden = true;
  document.body.append(link);
  try {
    link.click();
  } finally {
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), REVOKE_AFTER_MS);
  }
}

/** The table as a CSV named after it and today's date in the browser. */
export function downloadTable(table: HTMLTableElement, name: string): void {
  downloadCsv(csvFileName(name, new Date()), toCsv(readTable(table)));
}
