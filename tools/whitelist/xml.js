// A small XML tokenizer, enough for the XML inside .ods files

/**
 * `empty` is a self-closing tag like `<a/>`, which has no end event
 * @typedef {{ kind: "start", name: string, attrs: Map<string, string>, empty: boolean }
 *   | { kind: "end", name: string }
 *   | { kind: "text", text: string }} XmlEvent
 */

/** @type {Record<string, string>} */
const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

/** @param {string} s */
function unescape(s) {
  return s.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-z]+);/g, (match, entity) => {
    if (entity.startsWith("#x")) {
      return String.fromCodePoint(parseInt(entity.slice(2), 16));
    }
    if (entity.startsWith("#")) {
      return String.fromCodePoint(parseInt(entity.slice(1), 10));
    }
    const value = ENTITIES[entity];
    if (value === undefined) {
      throw new Error(`unknown XML entity ${match}`);
    }
    return value;
  });
}

const ATTRIBUTE = /([^\s=]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;

/**
 * Index just past the `>` closing the tag at `open`
 * Attribute values may contain a raw `>`, so quotes are skipped
 * @param {string} xml
 * @param {number} open
 */
function tagEnd(xml, open) {
  /** @type {string | null} */
  let quote = null;
  for (let i = open + 1; i < xml.length; i++) {
    const c = xml[i];
    if (quote) {
      if (c === quote) {
        quote = null;
      }
    } else if (c === '"' || c === "'") {
      quote = c;
    } else if (c === ">") {
      return i + 1;
    }
  }
  throw new Error(`unterminated XML tag at ${open}`);
}

/**
 * @param {string} xml
 * @returns {Generator<XmlEvent>}
 */
export function* tokenize(xml) {
  let at = 0;
  while (at < xml.length) {
    const open = xml.indexOf("<", at);
    if (open < 0) {
      yield { kind: "text", text: unescape(xml.slice(at)) };
      return;
    }
    if (open > at) {
      yield { kind: "text", text: unescape(xml.slice(at, open)) };
    }

    /** @param {string} terminator */
    const skipPast = (terminator) => {
      const close = xml.indexOf(terminator, open);
      if (close < 0) {
        throw new Error(`unterminated XML at ${open}`);
      }
      return close + terminator.length;
    };

    if (xml.startsWith("<!--", open)) {
      at = skipPast("-->");
    } else if (xml.startsWith("<![CDATA[", open)) {
      at = skipPast("]]>");
      yield { kind: "text", text: xml.slice(open + 9, at - 3) };
    } else if (xml.startsWith("<?", open)) {
      at = skipPast("?>");
    } else if (xml.startsWith("<!", open)) {
      at = skipPast(">");
    } else if (xml.startsWith("</", open)) {
      at = skipPast(">");
      yield { kind: "end", name: xml.slice(open + 2, at - 1).trim() };
    } else {
      at = tagEnd(xml, open);
      let body = xml.slice(open + 1, at - 1);
      const empty = body.endsWith("/");
      if (empty) {
        body = body.slice(0, -1);
      }
      const nameEnd = body.search(/\s|$/);
      /** @type {Map<string, string>} */
      const attrs = new Map();
      for (const [, key, double, single] of body.slice(nameEnd).matchAll(ATTRIBUTE)) {
        attrs.set(key, unescape(double ?? single));
      }
      yield { kind: "start", name: body.slice(0, nameEnd), attrs, empty };
    }
  }
}
