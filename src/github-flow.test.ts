import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import { encryptSecret } from "./secret-box.js";

test("approved GitHub changes create a branch and draft pull request", async () => {
  const encryptionKey = randomBytes(32).toString("base64");
  process.env.DISCORD_TOKEN = "test-discord-token";
  process.env.OPENROUTER_API_KEY = "test-openrouter-key";
  process.env.DATABASE_URL = "";
  process.env.GITHUB_CLIENT_ID = "Iv1.test";
  process.env.GITHUB_CLIENT_SECRET = "test-secret";
  process.env.GITHUB_APP_SLUG = "argus-test";
  process.env.GITHUB_CALLBACK_URL = "https://example.test/auth/github/callback";
  process.env.GITHUB_TOKEN_ENCRYPTION_KEY = encryptionKey;

  const [{ Store }, github] = await Promise.all([import("./store.js"), import("./github.js")]);
  const store = new Store();
  const userId = "discord-user-1";
  await store.saveGithubConnection({
    discordUserId: userId,
    githubUserId: "1",
    githubLogin: "octocat",
    accessTokenEncrypted: encryptSecret("ghu_test", encryptionKey),
    refreshTokenEncrypted: null,
    accessTokenExpiresAt: new Date(Date.now() + 60 * 60_000),
    refreshTokenExpiresAt: null
  });
  await store.setSetting(`github_repo:${userId}`, "octocat/demo");

  const originalFetch = globalThis.fetch;
  const requests: Array<{ url: string; method: string; body?: Record<string, unknown> }> = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    const method = init.method || "GET";
    const body = typeof init.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : undefined;
    requests.push({ url, method, ...(body ? { body } : {}) });
    const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
    if (url.endsWith("/user/installations?per_page=100")) return json({ installations: [{ id: 7, account: { login: "octocat" }, repository_selection: "selected", permissions: { contents: "write", pull_requests: "write" } }] });
    if (url.endsWith("/user/installations/7/repositories?per_page=100")) return json({ repositories: [{ id: 9, full_name: "octocat/demo", private: true, html_url: "https://github.com/octocat/demo", default_branch: "main" }] });
    if (url.includes("/git/ref/heads/main")) return json({ object: { sha: "base-sha" } });
    if (url.includes("/contents/README.md?") && method === "GET") return json({ type: "file", sha: "file-sha" });
    if (url.endsWith("/git/refs") && method === "POST") return json({ ref: body?.ref }, 201);
    if (url.endsWith("/contents/README.md") && method === "PUT") return json({ content: { sha: "new-file-sha" } }, 201);
    if (url.endsWith("/pulls") && method === "POST") return json({ number: 12, html_url: "https://github.com/octocat/demo/pull/12", title: body?.title }, 201);
    return json({ message: `Unhandled test request: ${method} ${url}` }, 500);
  };

  try {
    const pending = await github.prepareGithubFileChanges(store, userId, [{ action: "write", path: "README.md", content: "# Updated" }]);
    assert.equal(pending.emptyRepository, false);
    const applied = await github.applyGithubFileChanges(store, userId, pending.id);
    assert.equal(applied.initializedDefault, false);
    assert.equal(applied.pullRequest?.number, 12);
    assert.match(applied.branch, /^argus\/\d{4}-\d{2}-\d{2}-[a-z0-9_-]+$/);
    const pullRequest = requests.find((request) => request.url.endsWith("/pulls") && request.method === "POST");
    assert.equal(pullRequest?.body?.draft, true);
    assert.equal(pullRequest?.body?.base, "main");
    assert.equal(pullRequest?.body?.head, applied.branch);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
