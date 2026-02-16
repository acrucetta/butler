import assert from "node:assert/strict";
import test from "node:test";

import { toTelegramMarkdownV2 } from "./telegram-markdown.js";

test("converts single-asterisk emphasis to Telegram italic", () => {
  assert.equal(toTelegramMarkdownV2("*Bolt*"), "_Bolt_");
  assert.equal(toTelegramMarkdownV2("A *Bolt* update"), "A _Bolt_ update");
});

test("preserves underscore italics", () => {
  assert.equal(toTelegramMarkdownV2("_Bolt_"), "_Bolt_");
});

test("converts markdown bold to Telegram bold", () => {
  assert.equal(toTelegramMarkdownV2("**Bolt**"), "*Bolt*");
});

test("converts markdown bold-italic to Telegram nested format", () => {
  assert.equal(toTelegramMarkdownV2("***Bolt***"), "*_Bolt_*");
});

test("preserves links and code while escaping plain text", () => {
  assert.equal(
    toTelegramMarkdownV2("Use `npm run build` and [docs](https://example.com/path) now."),
    "Use `npm run build` and [docs](https://example.com/path) now\\."
  );
});
