"use strict";

// Restricted GFM-subset markdown renderer for the Dashboard's Trellis task
// documents (PRD / DESIGN / IMPLEMENT / research notes). UMD twin of
// dashboard-trellis-panel.js: required directly by tests, loaded as a
// sibling <script> by dashboard.html and consumed via globalThis — no DOM
// globals, no i18n, no IPC in here.
//
// Red lines (task PRD):
//   - The renderer is a pure function of (builder, markdown, options): all
//     element creation goes through the injected builder's createElement /
//     createTextNode, and text is only ever attached as text content — so
//     an HTML-injection payload renders as literal text, never executes.
//   - Unknown syntax fails OPEN: it stays visible as plain text instead of
//     crashing or being swallowed.
//   - Links render as their label text only (no anchors, no navigation).
//   - A very long document is stopped after MD_MAX_RENDER_LINES rendered
//     lines; the caller learns via the returned `truncated` flag and shows
//     its own (i18n) note.

(function exposeTrellisDocRenderer(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.ClawdTrellisDocRenderer = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function buildTrellisDocRenderer() {
  // Defense against a maxed-out 1 MB document: rendering tens of thousands
  // of block nodes would stall the Dashboard page, so past this many lines
  // the rest of the document is dropped (the caller shows a truncation
  // note — same user-facing semantics as the byte cap on the main side).
  const MD_MAX_RENDER_LINES = 5000;
  // Inline nesting depth cap: `***a***`-style runs must not recurse without
  // bound. Past this depth the remainder renders as literal text.
  const MAX_INLINE_DEPTH = 4;

  const HEADING_RE = /^(#{1,4}) +(.*)$/;
  const FENCE_RE = /^```/;
  const FENCE_CLOSE_RE = /^```/;
  const TASK_RE = /^(\s*)(?:[-*]) \[([ xX])\]\s?(.*)$/;
  const TABLE_SEP_CELL_RE = /^:?-+:?$/;
  const DOC_PRIORITY = { "prd.md": 0, "design.md": 1, "implement.md": 2 };

  function isBlank(line) {
    return !line || !line.trim();
  }

  // Split a table row into cells, honoring `\|` as an escaped pipe. A line
  // like "| a \| b | c |" yields ["a | b", "c"]. Surrounding pipes are
  // dropped first, then the remainder splits on unescaped pipes.
  function splitTableRow(line) {
    let body = line.trim();
    if (body.startsWith("|")) body = body.slice(1);
    if (body.endsWith("|")) body = body.slice(0, -1);
    const cells = [];
    let current = "";
    for (let i = 0; i < body.length; i += 1) {
      const ch = body[i];
      if (ch === "\\" && body[i + 1] === "|") {
        current += "|";
        i += 1;
        continue;
      }
      if (ch === "|") {
        cells.push(current.trim());
        current = "";
        continue;
      }
      current += ch;
    }
    cells.push(current.trim());
    return cells;
  }

  // A separator row: every cell is `---` / `:--` / `:-:` / `--:` and at
  // least one cell exists.
  function isTableSeparator(line) {
    if (!line.includes("|") || !line.includes("-")) return false;
    const cells = splitTableRow(line);
    if (!cells.length) return false;
    return cells.every((cell) => cell.length > 0 && TABLE_SEP_CELL_RE.test(cell));
  }

  // ── inline tokenizer ──
  // Single forward pass per nesting level (every indexOf skips over consumed
  // spans), so a hostile input costs O(n × MAX_INLINE_DEPTH), not O(n²).
  // Unpaired markers stay as literal text — fail-open. Emphasis spans
  // additionally require non-whitespace content edges (the minimal GFM
  // flanking rule), so `2 * 3 * 4` never turns into italics.
  function isEmphasisContent(text) {
    return text.length > 0 && !/\s/.test(text[0]) && !/\s/.test(text[text.length - 1]);
  }
  function appendInline(builder, parent, text, depth) {
    if (typeof text !== "string" || !text) return;
    if (depth >= MAX_INLINE_DEPTH) {
      parent.appendChild(builder.createTextNode(text));
      return;
    }
    let plain = "";
    let i = 0;
    const flush = () => {
      if (plain) {
        parent.appendChild(builder.createTextNode(plain));
        plain = "";
      }
    };
    while (i < text.length) {
      const ch = text[i];
      if (ch === "`") {
        const close = text.indexOf("`", i + 1);
        if (close > i + 1) {
          flush();
          const span = builder.createElement("span");
          span.className = "md-code-inline";
          span.appendChild(builder.createTextNode(text.slice(i + 1, close)));
          parent.appendChild(span);
          i = close + 1;
          continue;
        }
        plain += ch;
        i += 1;
        continue;
      }
      if (ch === "*") {
        // `**bold**` first; only then a single `*italic*`. Non-empty
        // flanked content is required for both, so `****` and `2 * 3 * 4`
        // render literally.
        if (text.startsWith("**", i)) {
          const close = text.indexOf("**", i + 2);
          if (close > i + 2) {
            const content = text.slice(i + 2, close);
            if (isEmphasisContent(content)) {
              flush();
              const span = builder.createElement("span");
              span.className = "md-bold";
              appendInline(builder, span, content, depth + 1);
              parent.appendChild(span);
              i = close + 2;
              continue;
            }
          }
        }
        const close = text.indexOf("*", i + 1);
        if (close > i + 1) {
          const content = text.slice(i + 1, close);
          if (isEmphasisContent(content)) {
            flush();
            const span = builder.createElement("span");
            span.className = "md-italic";
            appendInline(builder, span, content, depth + 1);
            parent.appendChild(span);
            i = close + 1;
            continue;
          }
        }
        plain += ch;
        i += 1;
        continue;
      }
      if (ch === "[") {
        // `[label](url)` → label text only; the URL is dropped (no links).
        const labelClose = text.indexOf("]", i + 1);
        if (labelClose > i + 1 && text[labelClose + 1] === "(") {
          const end = text.indexOf(")", labelClose + 2);
          if (end !== -1) {
            flush();
            appendInline(builder, parent, text.slice(i + 1, labelClose), depth + 1);
            i = end + 1;
            continue;
          }
        }
        plain += ch;
        i += 1;
        continue;
      }
      plain += ch;
      i += 1;
    }
    flush();
  }

  function appendBlockText(builder, parent, className, text) {
    const el = builder.createElement("div");
    el.className = className;
    appendInline(builder, el, text, 0);
    parent.appendChild(el);
    return el;
  }

  // h2/h3 headings get a collapse toggle; the click behavior lives in the
  // Dashboard renderer (this module stays DOM-event-free), which flips the
  // `md-collapsed` class and hides the section's following siblings.
  // The toggle glyph is an inline SVG caret when the builder exposes
  // createElementNS (real Dashboard); text-only builders (tests, embedders
  // predating the SVG vocabulary) keep the ▾ fallback — the collapsed
  // state rotates via CSS either way, so no JS glyph flipping is needed.
  function buildHeadingCaretIcon(builder) {
    const ns = "http://www.w3.org/2000/svg";
    const svg = builder.createElementNS(ns, "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("width", "12");
    svg.setAttribute("height", "12");
    svg.setAttribute("aria-hidden", "true");
    svg.setAttribute("focusable", "false");
    const path = builder.createElementNS(ns, "path");
    path.setAttribute("d", "m6 9 6 6 6-6");
    path.setAttribute("fill", "none");
    path.setAttribute("stroke", "currentColor");
    path.setAttribute("stroke-width", "2");
    path.setAttribute("stroke-linecap", "round");
    path.setAttribute("stroke-linejoin", "round");
    svg.appendChild(path);
    return svg;
  }

  function appendHeading(builder, parent, level, text) {
    const el = builder.createElement("div");
    el.className = `md-h${level}`;
    // EVERY heading level is collapsible (h1 included): long docs like PRDs
    // have top-level sections (验收/Notes) that users expect to fold too.
    el.className += " md-heading-collapsible";
    el.setAttribute("aria-expanded", "true");
    const toggle = builder.createElement("span");
    toggle.className = "md-heading-toggle";
    if (typeof builder.createElementNS === "function") {
      toggle.appendChild(buildHeadingCaretIcon(builder));
    } else {
      toggle.textContent = "▾";
    }
    el.appendChild(toggle);
    appendInline(builder, el, text, 0);
    parent.appendChild(el);
    return el;
  }

  function appendCodeBlock(builder, parent, code) {
    const el = builder.createElement("div");
    el.className = "md-code";
    el.appendChild(builder.createTextNode(code));
    parent.appendChild(el);
  }

  function appendTable(builder, parent, headerCells, rows) {
    const table = builder.createElement("div");
    table.className = "md-table";
    const headRow = builder.createElement("div");
    headRow.className = "md-table-row md-table-row-head";
    for (const cell of headerCells) {
      const cellEl = builder.createElement("div");
      cellEl.className = "md-table-cell md-table-cell-head";
      appendInline(builder, cellEl, cell, 0);
      headRow.appendChild(cellEl);
    }
    table.appendChild(headRow);
    for (const row of rows) {
      const rowEl = builder.createElement("div");
      rowEl.className = "md-table-row";
      for (const cell of row) {
        const cellEl = builder.createElement("div");
        cellEl.className = "md-table-cell";
        appendInline(builder, cellEl, cell, 0);
        rowEl.appendChild(cellEl);
      }
      table.appendChild(rowEl);
    }
    parent.appendChild(table);
  }

  function appendTaskItem(builder, parent, indent, checked, text) {
    const level = Math.min(Math.floor(indent.length / 2), 5);
    const el = builder.createElement("div");
    el.className = `md-task md-task-l${level}`;
    const box = builder.createElement("span");
    box.className = checked ? "md-task-box is-checked" : "md-task-box";
    box.textContent = checked ? "☑" : "☐";
    el.appendChild(box);
    const textEl = builder.createElement("span");
    textEl.className = "md-task-text";
    appendInline(builder, textEl, text, 0);
    el.appendChild(textEl);
    parent.appendChild(el);
  }

  // markdown → { root, truncated }. `root` is a builder element (class
  // "md-doc") carrying one child per block; `truncated` reports that the
  // line cap dropped the rest of the document.
  function renderMarkdownDoc(builder, markdown, options) {
    const maxLines = options && Number.isInteger(options.maxLines) && options.maxLines >= 0
      ? options.maxLines
      : MD_MAX_RENDER_LINES;
    const root = builder.createElement("div");
    root.className = "md-doc";
    const text = typeof markdown === "string" ? markdown.replace(/\r\n?/g, "\n") : "";
    const lines = text.split("\n");
    let renderedLines = 0;
    let truncated = false;

    let paragraph = [];
    const flushParagraph = () => {
      if (!paragraph.length) return;
      appendBlockText(builder, root, "md-p", paragraph.join("\n"));
      paragraph = [];
    };

    for (let i = 0; i < lines.length; i += 1) {
      if (renderedLines >= maxLines) {
        truncated = true;
        break;
      }
      const line = lines[i];
      const next = i + 1 < lines.length ? lines[i + 1] : "";

      if (FENCE_RE.test(line.trim())) {
        flushParagraph();
        // Fenced code block: literal text until the closing fence; an
        // unclosed fence runs to EOF (fail-open, never a crash).
        const codeLines = [];
        i += 1;
        while (i < lines.length) {
          if (renderedLines + codeLines.length >= maxLines) {
            truncated = true;
            break;
          }
          if (FENCE_CLOSE_RE.test(lines[i].trim())) break;
          codeLines.push(lines[i]);
          i += 1;
        }
        if (codeLines.length) appendCodeBlock(builder, root, codeLines.join("\n"));
        renderedLines += codeLines.length + 1;
        continue;
      }

      if (isBlank(line)) {
        flushParagraph();
        renderedLines += 1;
        continue;
      }

      const heading = HEADING_RE.exec(line);
      if (heading) {
        flushParagraph();
        appendHeading(builder, root, heading[1].length, heading[2].trim());
        renderedLines += 1;
        continue;
      }

      if (line.includes("|") && isTableSeparator(next)) {
        flushParagraph();
        const headerCells = splitTableRow(line);
        i += 2; // header + separator consumed
        const rows = [];
        while (i < lines.length) {
          if (renderedLines + rows.length >= maxLines) {
            truncated = true;
            break;
          }
          const rowLine = lines[i];
          if (isBlank(rowLine) || !rowLine.includes("|")) break;
          rows.push(splitTableRow(rowLine));
          i += 1;
        }
        appendTable(builder, root, headerCells, rows);
        renderedLines += rows.length + 2;
        i -= 1; // the outer loop's i += 1 re-advances
        continue;
      }

      const task = TASK_RE.exec(line);
      if (task) {
        flushParagraph();
        appendTaskItem(builder, root, task[1], task[2] !== " ", task[3]);
        renderedLines += 1;
        continue;
      }

      // Unknown syntax (blockquotes, ordered lists, h5/h6, setext rules,
      // raw HTML, …) stays visible as paragraph text — fail-open.
      paragraph.push(line);
      renderedLines += 1;
    }
    flushParagraph();
    return { root, truncated };
  }

  // Document tab ordering for the detail card: the canonical Trellis files
  // first (PRD → DESIGN → IMPLEMENT), everything else alphabetically.
  function compareDocNames(a, b) {
    const pa = DOC_PRIORITY[a];
    const pb = DOC_PRIORITY[b];
    if (pa !== undefined || pb !== undefined) {
      if (pa === undefined) return 1;
      if (pb === undefined) return -1;
      return pa - pb;
    }
    return a < b ? -1 : a > b ? 1 : 0;
  }

  return {
    renderMarkdownDoc,
    compareDocNames,
    MD_MAX_RENDER_LINES,
    MAX_INLINE_DEPTH,
  };
});
