import "dotenv/config";
import { z } from "zod";

const booleanString = z
  .enum(["true", "false"])
  .default("false")
  .transform((value) => value === "true");

const schema = z.object({
  DISCORD_TOKEN: z.string().min(1),
  OPENROUTER_API_KEY: z.string().min(1),
  DATABASE_URL: z.string().optional(),
  PORT: z.coerce.number().int().positive().default(10000),
  ALLOWED_CHANNEL_IDS: z.string().default(""),
  OWNER_IDS: z.string().default(""),
  BOUNTY_CHANNEL_ID: z.string().optional(),
  BOUNTY_MONITOR_URL: z.preprocess((value) => value === "" ? undefined : value, z.string().url().optional()),
  BOUNTY_MONITOR_TOKEN: z.string().optional(),
  PROGRAMMER_CHANNEL_ID: z.string().optional(),
  ENGINEER_CHANNEL_ID: z.string().optional(),
  CREATIVE_CHANNEL_ID: z.string().optional(),
  RESEARCHER_CHANNEL_ID: z.string().optional(),
  COORDINATOR_CHANNEL_ID: z.string().optional(),
  DEFAULT_MODEL: z.string().default("openrouter/auto"),
  PROGRAMMER_MODEL: z.string().optional(),
  ENGINEER_MODEL: z.string().optional(),
  CREATIVE_MODEL: z.string().optional(),
  RESEARCHER_MODEL: z.string().optional(),
  COORDINATOR_MODEL: z.string().optional(),
  GITHUB_CLIENT_ID: z.string().optional(),
  GITHUB_CLIENT_SECRET: z.string().optional(),
  GITHUB_APP_SLUG: z.string().optional(),
  GITHUB_CALLBACK_URL: z.preprocess((value) => value === "" ? undefined : value, z.string().url().optional()),
  GITHUB_TOKEN_ENCRYPTION_KEY: z.string().optional(),
  MAX_AGENT_REPLIES: z.coerce.number().int().min(1).max(10).default(5),
  MAX_CONTEXT_MESSAGES: z.coerce.number().int().min(4).max(100).default(20),
  DAILY_REQUEST_LIMIT: z.coerce.number().int().positive().default(100),
  AUTONOMOUS_ENABLED: booleanString,
  AUTONOMOUS_INTERVAL_MINUTES: z.coerce.number().int().min(5).default(30)
});

const result = schema.safeParse(process.env);
if (!result.success) {
  console.error("Invalid environment configuration", result.error.flatten().fieldErrors);
  process.exit(1);
}

const env = result.data;

const githubValues = [env.GITHUB_CLIENT_ID, env.GITHUB_CLIENT_SECRET, env.GITHUB_APP_SLUG, env.GITHUB_TOKEN_ENCRYPTION_KEY];
const githubConfigured = githubValues.every(Boolean);
if (githubValues.some(Boolean) && !githubConfigured) {
  console.error("GitHub integration requires GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET, GITHUB_APP_SLUG and GITHUB_TOKEN_ENCRYPTION_KEY together");
  process.exit(1);
}
if (githubConfigured) {
  const rawKey = env.GITHUB_TOKEN_ENCRYPTION_KEY!;
  const decodedKey = /^[0-9a-f]{64}$/i.test(rawKey) ? Buffer.from(rawKey, "hex") : Buffer.from(rawKey, "base64");
  if (decodedKey.length !== 32) {
    console.error("GITHUB_TOKEN_ENCRYPTION_KEY must contain exactly 32 random bytes encoded as base64 or hex");
    process.exit(1);
  }
}

export const config = {
  ...env,
  allowedChannelIds: new Set(env.ALLOWED_CHANNEL_IDS.split(",").map((v) => v.trim()).filter(Boolean)),
  ownerIds: new Set(env.OWNER_IDS.split(",").map((v) => v.trim()).filter(Boolean)),
  githubConfigured,
  agentChannelIds: {
    programmer: env.PROGRAMMER_CHANNEL_ID,
    engineer: env.ENGINEER_CHANNEL_ID,
    creative: env.CREATIVE_CHANNEL_ID,
    researcher: env.RESEARCHER_CHANNEL_ID,
    coordinator: env.COORDINATOR_CHANNEL_ID
  }
};
