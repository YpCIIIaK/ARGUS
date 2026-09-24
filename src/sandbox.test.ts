import assert from "node:assert/strict";
import test from "node:test";

process.env.DISCORD_TOKEN = "test-discord-token";
process.env.OPENROUTER_API_KEY = "test-openrouter-key";

const { detectProjectCommands } = await import("./sandbox.js");
const file = (path: string, content = "") => ({ path, content: Buffer.from(content) });

test("detects npm checks from package scripts", () => {
  const commands = detectProjectCommands([
    file("package.json", JSON.stringify({ scripts: { test: "node --test", build: "tsc" } })),
    file("package-lock.json")
  ]);
  assert.deepEqual(commands, ["npm ci", "npm run test", "npm run build"]);
});

test("detects pnpm and orders quality checks", () => {
  const commands = detectProjectCommands([
    file("package.json", JSON.stringify({ scripts: { lint: "eslint .", typecheck: "tsc --noEmit", test: "vitest" } })),
    file("pnpm-lock.yaml")
  ]);
  assert.deepEqual(commands, ["corepack enable && pnpm install --frozen-lockfile", "npm run lint", "npm run typecheck", "npm run test"]);
});

test("detects Python tests and rejects unknown projects", () => {
  assert.deepEqual(detectProjectCommands([file("requirements.txt"), file("tests/test_app.py")]), [
    "python -m pip install -r requirements.txt", "python -m pytest -q"
  ]);
  assert.throws(() => detectProjectCommands([file("README.md")]), /Node\.js и Python/);
});
