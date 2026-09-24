import assert from "node:assert/strict";
import test from "node:test";

process.env.DISCORD_TOKEN = "test-discord-token";
process.env.OPENROUTER_API_KEY = "test-openrouter-key";
process.env.DATABASE_URL = "";

const { Store } = await import("./store.js");

test("agent task lifecycle is stored and listed by channel", async () => {
  const store = new Store();
  await store.init();
  const task = await store.createAgentTask({ channelId: "channel-a", requestedBy: "Координатор", assignedTo: "Программист", description: "Проверить сборку" });
  assert.equal(task.status, "running");
  await store.finishAgentTask(task.id, "done", "Сборка прошла");
  const tasks = await store.listAgentTasks("channel-a");
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0]?.status, "done");
  assert.equal(tasks[0]?.result, "Сборка прошла");
  assert.deepEqual(await store.listAgentTasks("channel-b"), []);
});
