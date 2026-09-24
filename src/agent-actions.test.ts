import assert from "node:assert/strict";
import test from "node:test";
import type { Agent, AgentCapability, AgentId } from "./agents.js";
import { parseAgentActions } from "./agent-actions.js";

function mockAgent(id: AgentId, capabilities: AgentCapability[]): Agent {
  return { id, capabilities, name: id, channelName: id, emoji: "🤖", color: 0, model: "test", prompt: "test", keywords: [] };
}

test("programmer can create a safe Discord attachment", () => {
  const programmer = mockAgent("programmer", ["create_file", "write_code"]);
  const parsed = parseAgentActions(
    'Готово.\n[CREATE_FILE name="../report.md"]\n# Report\ncontent\n[/CREATE_FILE]',
    programmer
  );
  assert.equal(parsed.content, "Готово.");
  assert.deepEqual(parsed.files, [{ name: "report.md", content: "# Report\ncontent" }]);
});

test("agent without the capability cannot create files but can delegate", () => {
  const researcher = mockAgent("researcher", ["research"]);
  const parsed = parseAgentActions(
    '[CREATE_FILE name="secret.txt"]\nnope\n[/CREATE_FILE]\n[DELEGATE agent="programmer"]\nСоздай report.md\n[/DELEGATE]',
    researcher
  );
  assert.deepEqual(parsed.files, []);
  assert.deepEqual(parsed.delegations, [{ agentId: "programmer", task: "Создай report.md" }]);
});

test("unknown agents and empty delegation tasks are ignored", () => {
  const coordinator = mockAgent("coordinator", ["coordination"]);
  const parsed = parseAgentActions(
    '[DELEGATE agent="unknown"]test[/DELEGATE]\n[DELEGATE agent="engineer"]   [/DELEGATE]',
    coordinator
  );
  assert.deepEqual(parsed.delegations, []);
});

test("programmer can propose safe GitHub writes and deletes", () => {
  const programmer = mockAgent("programmer", ["github_files"]);
  const parsed = parseAgentActions(
    '[GITHUB_FILE action="write" path="src/app.ts"]\nexport const ok = true;\n[/GITHUB_FILE]\n[GITHUB_FILE action="delete" path="old.txt"]\n[/GITHUB_FILE]',
    programmer
  );
  assert.deepEqual(parsed.githubChanges, [
    { action: "write", path: "src/app.ts", content: "export const ok = true;" },
    { action: "delete", path: "old.txt" }
  ]);
});

test("GitHub file proposals reject traversal and secret paths", () => {
  const programmer = mockAgent("programmer", ["github_files"]);
  const parsed = parseAgentActions(
    '[GITHUB_FILE action="write" path="../secret.txt"]x[/GITHUB_FILE]\n[GITHUB_FILE action="write" path=".env"]x[/GITHUB_FILE]',
    programmer
  );
  assert.deepEqual(parsed.githubChanges, []);
});

test("programmer can request safe GitHub files before editing", () => {
  const programmer = mockAgent("programmer", ["github_files"]);
  const parsed = parseAgentActions('[GITHUB_READ path="src/index.ts"][/GITHUB_READ]\n[GITHUB_READ path="../.env"][/GITHUB_READ]', programmer);
  assert.deepEqual(parsed.githubReads, ["src/index.ts"]);
});
