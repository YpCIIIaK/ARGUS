import assert from "node:assert/strict";
import test from "node:test";
import { claudeCodeEffort, claudeCodeModel, isClaudeCodeModel, parseClaudeCodeResult } from "./claude-code.js";

test("recognizes Claude Code subscription model identifiers", () => {
  assert.equal(isClaudeCodeModel("claude-code/sonnet"), true);
  assert.equal(isClaudeCodeModel("anthropic/claude-sonnet"), false);
  assert.equal(claudeCodeModel("claude-code/opus"), "opus");
});

test("maps unsupported low-end effort values to Claude Code low", () => {
  assert.equal(claudeCodeEffort("none"), "low");
  assert.equal(claudeCodeEffort("minimal"), "low");
  assert.equal(claudeCodeEffort("max"), "max");
});

test("parses Claude Code JSON usage", () => {
  const result = parseClaudeCodeResult(JSON.stringify({
    type: "result",
    subtype: "success",
    is_error: false,
    result: "Готово",
    total_cost_usd: 0,
    usage: { input_tokens: 10, cache_read_input_tokens: 4, output_tokens: 3 }
  }), "sonnet");
  assert.equal(result.content, "Готово");
  assert.equal(result.model, "claude-code/sonnet");
  assert.deepEqual(result.usage, { promptTokens: 14, completionTokens: 3, totalTokens: 17, costUsd: 0 });
});
