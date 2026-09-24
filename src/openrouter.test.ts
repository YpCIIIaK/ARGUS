import assert from "node:assert/strict";
import test from "node:test";
import { currentDateTimeContext } from "./openrouter.js";

test("every model request can receive an explicit current date, time and zone", () => {
  const context = currentDateTimeContext(new Date("2026-09-24T12:34:56.000Z"));
  assert.match(context, /2026/);
  assert.match(context, /Asia\/Qyzylorda/);
  assert.match(context, /2026-09-24T12:34:56\.000Z/);
});
