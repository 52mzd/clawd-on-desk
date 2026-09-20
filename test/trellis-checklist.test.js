"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert");

const {
  parseImplementChecklist,
  truncateNextStep,
  NEXT_STEP_MAX_LEN,
} = require("../src/trellis-checklist");

const EMPTY = { items: [], done: 0, total: 0, nextUncheckedText: null };

describe("parseImplementChecklist", () => {
  it("returns the empty shape for null/undefined/non-string/empty input", () => {
    assert.deepStrictEqual(parseImplementChecklist(null), EMPTY);
    assert.deepStrictEqual(parseImplementChecklist(undefined), EMPTY);
    assert.deepStrictEqual(parseImplementChecklist(42), EMPTY);
    assert.deepStrictEqual(parseImplementChecklist(""), EMPTY);
  });

  it("returns the empty shape when no line matches a checkbox", () => {
    assert.deepStrictEqual(parseImplementChecklist("# plan\n\nsome prose\n- bullet\n"), EMPTY);
    // Looks like a checkbox but is not: empty brackets / wrong order.
    assert.deepStrictEqual(parseImplementChecklist("- []empty brackets\nx [ ] not a list item\n"), EMPTY);
  });

  it("parses a checkbox written without a space after the bracket", () => {
    const parsed = parseImplementChecklist("- [x]no-space-marker\n- [ ] next\n");
    assert.strictEqual(parsed.done, 1);
    assert.strictEqual(parsed.items[0].text, "no-space-marker");
  });

  it("parses checked and unchecked items with counts and first unchecked text", () => {
    const md = [
      "# Implementation",
      "",
      "- [x] parse task.json",
      "- [ ] wire the bubble",
      "- [x] add tests",
      "- [ ] run npm test",
    ].join("\n");
    assert.deepStrictEqual(parseImplementChecklist(md), {
      items: [
        { text: "parse task.json", checked: true },
        { text: "wire the bubble", checked: false },
        { text: "add tests", checked: true },
        { text: "run npm test", checked: false },
      ],
      done: 2,
      total: 4,
      nextUncheckedText: "wire the bubble",
    });
  });

  it("accepts indented checkboxes and uppercase X", () => {
    const md = "- [x] top\n  - [X] nested done\n  - [ ] nested next\n";
    const parsed = parseImplementChecklist(md);
    assert.strictEqual(parsed.total, 3);
    assert.strictEqual(parsed.done, 2);
    assert.strictEqual(parsed.nextUncheckedText, "nested next");
  });

  it("strips markdown emphasis from item text", () => {
    const md = "- [ ] **bold step**\n- [x] `code` step\n- [ ] plain\n";
    const parsed = parseImplementChecklist(md);
    assert.strictEqual(parsed.items[0].text, "bold step");
    assert.strictEqual(parsed.items[1].text, "code step");
    assert.strictEqual(parsed.nextUncheckedText, "bold step");
  });

  it("keeps only the first line of an item (continuation lines are not items)", () => {
    const md = "- [ ] step one\n  continuation detail\n- [x] step two\n";
    const parsed = parseImplementChecklist(md);
    assert.strictEqual(parsed.total, 2);
    assert.strictEqual(parsed.items[0].text, "step one");
  });

  it("skips checkboxes whose text is empty after stripping", () => {
    const md = "- [ ] **` `**\n- [ ] real step\n";
    const parsed = parseImplementChecklist(md);
    assert.strictEqual(parsed.total, 1);
    assert.strictEqual(parsed.nextUncheckedText, "real step");
  });

  it("all checked → nextUncheckedText null, done equals total", () => {
    const md = "- [x] a\n- [x] b\n";
    assert.deepStrictEqual(parseImplementChecklist(md), {
      items: [
        { text: "a", checked: true },
        { text: "b", checked: true },
      ],
      done: 2,
      total: 2,
      nextUncheckedText: null,
    });
  });

  it("handles CRLF line endings", () => {
    const parsed = parseImplementChecklist("- [x] a\r\n- [ ] b\r\n");
    assert.strictEqual(parsed.total, 2);
    assert.strictEqual(parsed.nextUncheckedText, "b");
  });

  it("survives a hostile very long line", () => {
    const long = "x".repeat(500_000);
    const parsed = parseImplementChecklist(`- [ ] ${long}\n`);
    assert.strictEqual(parsed.total, 1);
    assert.strictEqual(parsed.items[0].text.length, 500_000);
    assert.strictEqual(parsed.nextUncheckedText.length, 500_000);
  });
});

describe("truncateNextStep", () => {
  it("returns short text unchanged", () => {
    assert.strictEqual(truncateNextStep("fix the login bug"), "fix the login bug");
  });

  it("returns empty string for null/undefined", () => {
    assert.strictEqual(truncateNextStep(null), "");
    assert.strictEqual(truncateNextStep(undefined), "");
  });

  it("caps at NEXT_STEP_MAX_LEN code points with an ellipsis", () => {
    const text = "a".repeat(NEXT_STEP_MAX_LEN + 10);
    const truncated = truncateNextStep(text);
    assert.strictEqual(Array.from(truncated).length, NEXT_STEP_MAX_LEN + 1); // + ellipsis
    assert.ok(truncated.endsWith("…"));
    assert.ok(truncated.startsWith("a".repeat(NEXT_STEP_MAX_LEN)));
  });

  it("counts surrogate pairs as single characters", () => {
    const emoji = "🦊".repeat(NEXT_STEP_MAX_LEN + 2);
    const truncated = truncateNextStep(emoji);
    assert.strictEqual(Array.from(truncated).length, NEXT_STEP_MAX_LEN + 1);
  });
});
