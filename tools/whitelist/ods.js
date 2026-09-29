// Just enough of the OpenDocument spreadsheet format to read cell text and background colors

import { readFileSync } from "node:fs";

import { tokenize } from "./xml.js";
import { readZip } from "./zip.js";

/**
 * @typedef {object} Cell
 * @property {string} text
 * @property {string} color Background color as `#rrggbb`, empty if none
 */

// Big repeat counts pad the sheet to its full size, and nothing past this has content
const MAX_REPEAT = 64;

/**
 * Rows of the first sheet, without the empty ones
 * @param {string} path
 * @returns {Cell[][]}
 */
export function readFirstSheet(path) {
  let archive;
  try {
    archive = readZip(readFileSync(path));
  } catch (e) {
    throw new Error(`${path} isn't an .ods file: ${/** @type {Error} */ (e).message}`);
  }

  /** @param {string} name */
  const entry = (name) => {
    const read = archive.get(name);
    if (!read) {
      throw new Error(`missing ${name}`);
    }
    return read().toString("utf8");
  };

  /** @type {Map<string, string>} */
  const colors = new Map();
  for (const name of ["styles.xml", "content.xml"]) {
    readCellColors(entry(name), colors);
  }
  return readRows(entry("content.xml"), colors);
}

/**
 * @param {Map<string, string>} attrs
 * @param {string} name
 */
function repeat(attrs, name) {
  const n = Number.parseInt(attrs.get(name) ?? "", 10);
  return Number.isNaN(n) ? 1 : n;
}

/**
 * Maps cell style names to their background color
 * @param {string} xml
 * @param {Map<string, string>} colors
 */
function readCellColors(xml, colors) {
  /** @type {string | undefined} */
  let style;
  for (const e of tokenize(xml)) {
    if (e.kind === "start" && !e.empty && e.name === "style:style") {
      style = e.attrs.get("style:name");
    } else if (e.kind === "start" && e.name === "style:table-cell-properties") {
      const color = e.attrs.get("fo:background-color");
      if (style !== undefined && color !== undefined) {
        colors.set(style, color.toLowerCase());
      }
    } else if (e.kind === "end" && e.name === "style:style") {
      style = undefined;
    }
  }
}

/**
 * @param {string} xml
 * @param {Map<string, string>} colors
 * @returns {Cell[][]}
 */
function readRows(xml, colors) {
  /** @type {(string | undefined)[]} */
  const columnStyles = [];
  /** @type {Cell[][]} */
  const rows = [];
  /** @type {Cell[]} */
  let row = [];
  /** @type {{ cell: Cell, count: number } | null} */
  let open = null;
  let inFirstTable = false;
  let tablesSeen = 0;

  /**
   * A cell's own style, or else its column's
   * @param {string | undefined} style
   */
  const colorOf = (style) => colors.get(style ?? columnStyles[row.length] ?? "") ?? "";

  /** @param {string} name */
  const isCell = (name) => name === "table:table-cell" || name === "table:covered-table-cell";

  for (const e of tokenize(xml)) {
    if (e.kind === "start" && !e.empty && e.name === "table:table") {
      tablesSeen++;
      inFirstTable = tablesSeen === 1;
      continue;
    }
    if (e.kind === "end" && e.name === "table:table") {
      inFirstTable = false;
      continue;
    }
    if (!inFirstTable) {
      continue;
    }

    if (e.kind === "start" && e.name === "table:table-column") {
      const count = Math.min(repeat(e.attrs, "table:number-columns-repeated"), MAX_REPEAT);
      for (let i = 0; i < count; i++) {
        columnStyles.push(e.attrs.get("table:default-cell-style-name"));
      }
    } else if (e.kind === "start" && !e.empty && e.name === "table:table-row") {
      row = [];
    } else if (e.kind === "end" && e.name === "table:table-row") {
      if (row.some((c) => c.text.trim() !== "")) {
        rows.push(row);
        row = [];
      }
    } else if (e.kind === "start" && isCell(e.name)) {
      const count = Math.min(repeat(e.attrs, "table:number-columns-repeated"), MAX_REPEAT);
      const style = e.attrs.get("table:style-name");
      if (e.empty) {
        for (let i = 0; i < count; i++) {
          row.push({ text: "", color: colorOf(style) });
        }
      } else {
        open = { cell: { text: "", color: colorOf(style) }, count };
      }
    } else if (e.kind === "end" && isCell(e.name)) {
      if (open) {
        for (let i = 0; i < open.count; i++) {
          row.push({ ...open.cell });
        }
        open = null;
      }
    } else if (e.kind === "start" && !e.empty && e.name === "text:p") {
      // Paragraphs in one cell are joined with a space
      if (open && open.cell.text !== "") {
        open.cell.text += " ";
      }
    } else if (e.kind === "start" && e.empty && e.name === "text:s") {
      if (open) {
        open.cell.text += " ".repeat(repeat(e.attrs, "text:c"));
      }
    } else if (e.kind === "text") {
      if (open) {
        open.cell.text += e.text;
      }
    }
  }

  return rows;
}
