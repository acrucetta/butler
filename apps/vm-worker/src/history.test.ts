import assert from "node:assert/strict";
import test from "node:test";
import { limitHistoryTurns } from "./history.js";

function msg(role: string): { role: string } {
  return { role };
}

test("empty messages returns empty array", () => {
  assert.deepStrictEqual(limitHistoryTurns([], 5), []);
});

test("under limit returns all messages", () => {
  const messages = [msg("user"), msg("assistant"), msg("user"), msg("assistant")];
  const result = limitHistoryTurns(messages, 5);
  assert.deepStrictEqual(result, messages);
});

test("exactly at limit returns all messages", () => {
  const messages = [msg("user"), msg("assistant"), msg("user"), msg("assistant")];
  const result = limitHistoryTurns(messages, 2);
  assert.deepStrictEqual(result, messages);
});

test("over limit keeps only last N user turns", () => {
  const messages = [
    msg("user"),       // turn 1 — should be cut
    msg("assistant"),  // response to turn 1 — should be cut
    msg("user"),       // turn 2
    msg("assistant"),  // response to turn 2
    msg("user"),       // turn 3
    msg("assistant")   // response to turn 3
  ];

  const result = limitHistoryTurns(messages, 2);
  assert.equal(result.length, 4);
  assert.equal(result[0].role, "user");   // turn 2
  assert.equal(result[1].role, "assistant");
  assert.equal(result[2].role, "user");   // turn 3
  assert.equal(result[3].role, "assistant");
});

test("undefined limit returns all messages", () => {
  const messages = [msg("user"), msg("assistant"), msg("user"), msg("assistant")];
  const result = limitHistoryTurns(messages, undefined);
  assert.deepStrictEqual(result, messages);
});

test("zero limit returns all messages", () => {
  const messages = [msg("user"), msg("assistant")];
  const result = limitHistoryTurns(messages, 0);
  assert.deepStrictEqual(result, messages);
});

test("negative limit returns all messages", () => {
  const messages = [msg("user"), msg("assistant")];
  const result = limitHistoryTurns(messages, -1);
  assert.deepStrictEqual(result, messages);
});

test("preserves non-user messages between turns", () => {
  const messages = [
    msg("user"),            // turn 1 — cut
    msg("assistant"),       // cut
    msg("bashExecution"),   // cut
    msg("user"),            // turn 2
    msg("assistant"),
    msg("custom"),
    msg("user"),            // turn 3
    msg("assistant")
  ];

  const result = limitHistoryTurns(messages, 2);
  assert.equal(result.length, 5);
  assert.equal(result[0].role, "user"); // turn 2
});

test("limit of 1 keeps only last user turn", () => {
  const messages = [
    msg("user"),
    msg("assistant"),
    msg("user"),
    msg("assistant")
  ];

  const result = limitHistoryTurns(messages, 1);
  assert.equal(result.length, 2);
  assert.equal(result[0].role, "user");
  assert.equal(result[1].role, "assistant");
});

test("default limit is applied when argument omitted", () => {
  // With fewer than 30 user turns, all should be returned
  const messages = Array.from({ length: 10 }, (_, i) =>
    i % 2 === 0 ? msg("user") : msg("assistant")
  );
  const result = limitHistoryTurns(messages);
  assert.deepStrictEqual(result, messages);
});
