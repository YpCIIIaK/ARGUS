import express from "express";
import { config } from "./config.js";
import { createDiscordClient } from "./discord.js";
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

const server = app.listen(config.PORT, "0.0.0.0", () => console.log(`Health server listening on ${config.PORT}`));

async function shutdown(signal: string) {
  console.log(`Received ${signal}, shutting down`);
  client.destroy();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
