import express from "express";
import { config } from "./config.js";
import { createDiscordClient } from "./discord.js";
import { completeGithubConnection } from "./github.js";
import { Store } from "./store.js";

const store = new Store();
await store.init();

const client = createDiscordClient(store);
await client.login(config.DISCORD_TOKEN);

const app = express();
app.get("/", (_request, response) => response.json({ name: "ForumDS", status: "ok" }));
app.get("/health", async (_request, response) => {
  const discordReady = client.isReady();
  const database = await store.healthCheck();
  const ok = discordReady && database.ok;
  response.status(ok ? 200 : 503).json({
    ok,
    discord: discordReady ? "connected" : "disconnected",
    database: {
      status: database.ok ? "connected" : "error",
      mode: database.mode,
      latencyMs: database.latencyMs,
      ...(database.error ? { error: database.error } : {})
    }
  });
});
app.get("/auth/github/callback", async (request, response) => {
  const code = typeof request.query.code === "string" ? request.query.code : "";
  const state = typeof request.query.state === "string" ? request.query.state : "";
  if (!code || !state) {
    response.status(400).type("html").send(githubResultPage("Подключение не завершено", "GitHub не вернул обязательные параметры code и state."));
    return;
  }
  try {
    const account = await completeGithubConnection(store, code, state);
    response.type("html").send(githubResultPage("GitHub подключён", `Аккаунт @${account.login} сохранён. Можно закрыть эту вкладку и вернуться в Discord.`));
  } catch (error) {
    console.error("GitHub OAuth callback failed", error);
    response.status(400).type("html").send(githubResultPage("Не удалось подключить GitHub", error instanceof Error ? error.message : "Неизвестная ошибка"));
  }
});

const server = app.listen(config.PORT, "0.0.0.0", () => console.log(`Health server listening on ${config.PORT}`));

async function shutdown(signal: string) {
  console.log(`Received ${signal}, shutting down`);
  client.destroy();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

function githubResultPage(title: string, message: string): string {
  const escape = (value: string) => value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!);
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${escape(title)}</title><style>body{margin:0;background:#0f1115;color:#f4f5f7;font:16px system-ui;display:grid;place-items:center;min-height:100vh}.card{max-width:560px;padding:32px;border:1px solid #30343b;border-radius:16px;background:#181b20}h1{margin-top:0;color:#8ea1ff}p{line-height:1.55}</style></head><body><main class="card"><h1>${escape(title)}</h1><p>${escape(message)}</p></main></body></html>`;
}
