import assert from "node:assert/strict";
import test from "node:test";

process.env.DISCORD_TOKEN = "test-discord-token";
process.env.OPENROUTER_API_KEY = "test-openrouter-key";

const { ruleDecision } = await import("./decision-engine.js");

test("explicit agent names are routed locally without a model", () => {
  const decision = ruleDecision("Программист, исправь код бота");
  assert.deepEqual(decision.agents, ["programmer"]);
  assert.equal(decision.source, "rules");
  assert.equal(decision.confidence, 0.99);
});

test("strong capability matches use deterministic routing", () => {
  const decision = ruleDecision("Нужно проверить архитектуру сервера и нагрузку системы");
  assert.deepEqual(decision.agents, ["engineer"]);
  assert.ok(decision.confidence >= 0.9);
});

test("ambiguous requests are marked for model routing", () => {
  const decision = ruleDecision("Помоги с этим проектом");
  assert.deepEqual(decision.agents, ["coordinator"]);
  assert.ok(decision.confidence < 0.9);
});

test("model router tries configured free models in order", async () => {
  const originalFetch = globalThis.fetch;
  const attempted: string[] = [];
  globalThis.fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body)) as { model: string };
    attempted.push(body.model);
    if (attempted.length === 1) return new Response(JSON.stringify({ error: { message: "rate limited" } }), { status: 429 });
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
      agents: ["researcher"], tool: "web", needsHuman: false, confidence: 0.87, reason: "Нужны актуальные источники."
    }) } }] }), { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    const { routeRequest } = await import("./decision-engine.js");
    const result = await routeRequest("Разберись, пожалуйста, с неизвестной новой темой");
    assert.deepEqual(attempted.slice(0, 2), ["nex-agi/nex-n2.5-mini:free", "inclusionai/ling-3.0-flash-sante:free"]);
    assert.equal(result.decision.model, "inclusionai/ling-3.0-flash-sante:free");
    assert.deepEqual(result.decision.agents, ["researcher"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
