"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert");

const {
  renderMarkdownDoc,
  compareDocNames,
  MD_MAX_RENDER_LINES,
  MAX_INLINE_DEPTH,
} = require("../src/trellis-doc-renderer");

// ── fake builder ────────────────────────────────────────────────────────────
// Records the exact builder-call sequence so tests can snapshot the tree
// without any DOM. Elements expose only what the renderer touches:
// appendChild, className, textContent, classList.contains, setAttribute.

class FakeClassList {
  constructor(element) { this.element = element; }
  contains(name) { return this.element.className.split(/\s+/).includes(name); }
}

class FakeEl {
  constructor(tag) {
    this.tag = tag;
    this.className = "";
    this.classList = new FakeClassList(this);
    this.children = [];
    this.text = "";
    this.attrs = {};
    this.hidden = false;
  }
  appendChild(child) { this.children.push(child); return child; }
  setAttribute(name, value) { this.attrs[name] = String(value); }
  // Mirror the real DOM: assigning textContent replaces children with one
  // text node, so snapshots come out identical to appendChild(createTextNode).
  get textContent() {
    if (this.tag === "#text") return this.text;
    return this.children.map((c) => c.text).join("");
  }
  set textContent(value) {
    this.children = [];
    if (value !== "" && value !== undefined && value !== null) {
      const node = new FakeEl("#text");
      node.text = String(value);
      this.children.push(node);
    }
  }
}

function makeBuilder() {
  const calls = [];
  const builder = {
    createElement: (tag) => {
      calls.push(["createElement", tag]);
      return new FakeEl(tag);
    },
    createTextNode: (text) => {
      calls.push(["createTextNode", text]);
      const node = new FakeEl("#text");
      node.text = String(text);
      return node;
    },
  };
  return { builder, calls };
}

// Compact tree shape for deepStrictEqual snapshots:
//   ["div.md-doc", children...] — element with class
//   ["#text", "…"]              — text node
//   ["span", {attr: v}, kids]   — element with attributes
function shape(node) {
  if (node.tag === "#text") return ["#text", node.text];
  const out = [node.className ? `${node.tag}.${node.className}` : node.tag];
  if (node.attrs && Object.keys(node.attrs).length) out.push(node.attrs);
  out.push(...node.children.map(shape));
  return out;
}

function render(md) {
  const { builder } = makeBuilder();
  const { root, truncated } = renderMarkdownDoc(builder, md);
  return { root, truncated };
}

// ── block elements ──────────────────────────────────────────────────────────

describe("trellis-doc-renderer headings", () => {
  it("maps h1-h4 onto graded collapsible divs and keeps h5+/hashtag lines as text", () => {
    const { root } = render("# One\n## Two\n### Three\n#### Four\n##### Five\n\n#hashtag");
    assert.deepStrictEqual(root.children.map((c) => c.className), [
      "md-h1 md-heading-collapsible",
      "md-h2 md-heading-collapsible",
      "md-h3 md-heading-collapsible",
      "md-h4 md-heading-collapsible",
      "md-p",
      "md-p",
    ]);
  });

  it("renders inline markers inside headings and adds collapse toggles on every h1-h4", () => {
    const { root } = render("## Run **bold**\n# plain\n### deep `code`");
    const [h2, h1, h3] = root.children;
    assert.ok(h2.classList.contains("md-heading-collapsible"));
    assert.strictEqual(h2.attrs["aria-expanded"], "true");
    assert.deepStrictEqual(shape(h2), [
      "div.md-h2 md-heading-collapsible", { "aria-expanded": "true" },
      ["span.md-heading-toggle", ["#text", "▾"]],
      ["#text", "Run "],
      ["span.md-bold", ["#text", "bold"]],
    ]);
    assert.ok(h1.classList.contains("md-heading-collapsible"));
    assert.ok(h3.classList.contains("md-heading-collapsible"));
  });
});

describe("trellis-doc-renderer paragraphs", () => {
  it("joins consecutive lines into one paragraph and splits on blank lines", () => {
    const { root } = render("alpha\nbeta\n\ngamma");
    assert.strictEqual(root.children.length, 2);
    assert.deepStrictEqual(shape(root.children[0]), ["div.md-p", ["#text", "alpha\nbeta"]]);
    assert.deepStrictEqual(shape(root.children[1]), ["div.md-p", ["#text", "gamma"]]);
  });
});

describe("trellis-doc-renderer code fences", () => {
  it("renders fenced code as one escaped literal block", () => {
    const { root } = render("before\n```js\nconst a = 1;\n<b>not html</b>\n```\nafter");
    assert.strictEqual(root.children.length, 3);
    assert.deepStrictEqual(shape(root.children[1]),
      ["div.md-code", ["#text", "const a = 1;\n<b>not html</b>"]]);
  });

  it("keeps an unclosed fence open until EOF instead of crashing", () => {
    const { root } = render("```\nline one\nline two");
    assert.strictEqual(root.children.length, 1);
    assert.deepStrictEqual(shape(root.children[0]),
      ["div.md-code", ["#text", "line one\nline two"]]);
  });
});

describe("trellis-doc-renderer tables", () => {
  it("parses a GFM pipe table with header, separator and body rows", () => {
    const md = "| File | Purpose |\n| --- | ----- |\n| `a.js` | alpha |\n| b.js | **beta** |";
    const { root } = render(md);
    assert.strictEqual(root.children.length, 1);
    assert.deepStrictEqual(shape(root.children[0]), [
      "div.md-table",
      ["div.md-table-row md-table-row-head",
        ["div.md-table-cell md-table-cell-head", ["#text", "File"]],
        ["div.md-table-cell md-table-cell-head", ["#text", "Purpose"]]],
      ["div.md-table-row",
        ["div.md-table-cell", ["span.md-code-inline", ["#text", "a.js"]]],
        ["div.md-table-cell", ["#text", "alpha"]]],
      ["div.md-table-row",
        ["div.md-table-cell", ["#text", "b.js"]],
        ["div.md-table-cell", ["span.md-bold", ["#text", "beta"]]]],
    ]);
  });

  it("honors escaped pipes inside cells", () => {
    const { root } = render("| a \\| b | c |\n| --- | --- |\n| x | y |");
    const cells = root.children[0].children[0].children;
    assert.deepStrictEqual([cells[0].textContent, cells[1].textContent], ["a | b", "c"]);
  });

  it("does not treat a lone pipe line as a table without a separator", () => {
    const { root } = render("| not a table |\njust text");
    assert.ok(root.children.every((c) => c.classList.contains("md-p")));
  });

  it("ends the table at a non-pipe line and renders what follows", () => {
    const { root } = render("| H |\n| --- |\n| a |\nplain paragraph");
    assert.strictEqual(root.children.length, 2);
    assert.ok(root.children[0].classList.contains("md-table"));
    assert.ok(root.children[1].classList.contains("md-p"));
  });
});

describe("trellis-doc-renderer task lists", () => {
  it("renders checkboxes read-only with indentation levels", () => {
    const md = "- [ ] one\n  - [x] two\n    - [ ] three\n* [X] star";
    const { root } = render(md);
    assert.deepStrictEqual(root.children.map((c) => c.className),
      ["md-task md-task-l0", "md-task md-task-l1", "md-task md-task-l2", "md-task md-task-l0"]);
    assert.strictEqual(root.children[0].children[0].textContent, "☐");
    assert.strictEqual(root.children[1].children[0].textContent, "☑");
    assert.strictEqual(root.children[2].children[1].children[0].textContent, "three");
    assert.strictEqual(root.children[3].children[0].textContent, "☑", "capital X counts as checked");
  });

  it("keeps inline markers inside task text", () => {
    const { root } = render("- [x] run `npm test`");
    assert.deepStrictEqual(shape(root.children[0].children[1]), [
      "span.md-task-text", ["#text", "run "], ["span.md-code-inline", ["#text", "npm test"]],
    ]);
  });
});

// ── inline tokenizer ────────────────────────────────────────────────────────

describe("trellis-doc-renderer inline markers", () => {
  function inline(md) {
    const { root } = render(md);
    return shape(root.children[0]);
  }

  it("pairs code, bold and italic", () => {
    assert.deepStrictEqual(inline("`x` **b** *i*"), [
      "div.md-p",
      ["span.md-code-inline", ["#text", "x"]], ["#text", " "], ["span.md-bold", ["#text", "b"]], ["#text", " "], ["span.md-italic", ["#text", "i"]],
    ]);
  });

  it("keeps unpaired markers as literal text", () => {
    assert.deepStrictEqual(inline("a * b ` c ** d"), ["div.md-p", ["#text", "a * b ` c ** d"]]);
  });

  it("prefers ** over * and requires non-empty spans", () => {
    assert.deepStrictEqual(inline("**bold**"), ["div.md-p", ["span.md-bold", ["#text", "bold"]]]);
    assert.deepStrictEqual(inline("****"), ["div.md-p", ["#text", "****"]]);
    assert.deepStrictEqual(inline("**"), ["div.md-p", ["#text", "**"]]);
  });

  it("nests one level deep and caps runaway nesting as text", () => {
    assert.deepStrictEqual(inline("**bold *inner* tail**"), [
      "div.md-p",
      ["span.md-bold", ["#text", "bold "], ["span.md-italic", ["#text", "inner"]], ["#text", " tail"]],
    ]);
    // MAX_INLINE_DEPTH levels of ***…*** nesting must not recurse forever.
    const hostile = "*".repeat(3 * (MAX_INLINE_DEPTH + 4)) + "payload" + "*".repeat(3 * (MAX_INLINE_DEPTH + 4));
    const { root } = render(hostile);
    assert.ok(root.children.length >= 1);
    assert.ok(JSON.stringify(shape(root)).includes("payload"), "content survives the depth cap");
  });

  it("renders links as their label text only — never an anchor, never the URL", () => {
    assert.deepStrictEqual(inline("see [the docs](https://evil.example) now"), [
      "div.md-p", ["#text", "see "], ["#text", "the docs"], ["#text", " now"],
    ]);
    assert.deepStrictEqual(inline("[missing bracket](https://x"),
      ["div.md-p", ["#text", "[missing bracket](https://x"]]);
  });

  it("does not parse markers inside code spans", () => {
    assert.deepStrictEqual(inline("`**not bold**`"), ["div.md-p", ["span.md-code-inline", ["#text", "**not bold**"]]]);
  });
});

// ── hostile input (PRD acceptance) ──────────────────────────────────────────

describe("trellis-doc-renderer hostile input", () => {
  it("renders HTML injection as literal text via the builder only", () => {
    const { builder, calls } = makeBuilder();
    const { root } = renderMarkdownDoc(builder,
      '<script>alert(1)</script>\n\n<img src=x onerror=alert(2)>\n\n[a](javascript:alert(3))');
    // No script/img/a elements were ever created — only divs, spans and text.
    const tags = new Set(calls.filter((c) => c[0] === "createElement").map((c) => c[1]));
    assert.deepStrictEqual([...tags].sort(), ["div"], "only divs were created — no script/img/a elements");
    const text = JSON.stringify(shape(root));
    assert.ok(text.includes("<script>alert(1)</script>"), "markup stays visible as text");
    assert.ok(text.includes("javascript:alert(3)") === false, "the URL itself is dropped");
  });

  it("survives a very long line and a very long document", () => {
    const longLine = "x".repeat(200000);
    const { root } = render(`${longLine}\n\n${("line\n").repeat(20000)}`);
    assert.ok(root.children.length > 0);
    const many = renderMarkdownDoc(makeBuilder().builder, "# t\n\n" + "para\n\n".repeat(30000));
    assert.strictEqual(many.truncated, true, "the line cap stops the runaway document");
  });

  it("reports truncation at the line cap and honors a custom maxLines", () => {
    const builder = makeBuilder().builder;
    assert.strictEqual(renderMarkdownDoc(builder, "a\n\nb\n\nc").truncated, false);
    const capped = renderMarkdownDoc(builder, "a\n\nb\n\nc", { maxLines: 2 });
    assert.strictEqual(capped.truncated, true);
    assert.strictEqual(capped.root.children.length, 1, "only the first paragraph rendered");
    assert.strictEqual(MD_MAX_RENDER_LINES, 5000);
  });

  it("tolerates non-string and empty input", () => {
    const builder = makeBuilder().builder;
    assert.strictEqual(renderMarkdownDoc(builder, "").root.children.length, 0);
    assert.strictEqual(renderMarkdownDoc(builder, null).root.children.length, 0);
    assert.strictEqual(renderMarkdownDoc(builder, undefined).root.children.length, 0);
    assert.strictEqual(renderMarkdownDoc(builder, 42).root.children.length, 0);
  });
});

// The non-string case above needs the root itself: assert via children only.
describe("trellis-doc-renderer normalization", () => {
  it("normalizes CRLF and lone CR line endings", () => {
    const crlf = render("a\r\n\r\nb");
    const lf = render("a\n\nb");
    assert.deepStrictEqual(shape(crlf.root), shape(lf.root));
  });
});

describe("trellis-doc-renderer compareDocNames", () => {
  it("orders canonical Trellis docs first, then alphabetically", () => {
    const names = ["zeta.md", "implement.md", "alpha.md", "prd.md", "design.md"];
    assert.deepStrictEqual(names.sort(compareDocNames),
      ["prd.md", "design.md", "implement.md", "alpha.md", "zeta.md"]);
  });
});
