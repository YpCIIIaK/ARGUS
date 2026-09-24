import "dotenv/config";
import { z } from "zod";

const booleanString = z
  .enum(["true", "false"])
  .default("false")
  .transform((value) => value === "true");
const reasoningEffort = z.enum(["none", "minimal", "low", "medium", "high", "xhigh", "max"]);

const timeZone = z.string().default("Asia/Qyzylorda").refine((value) => {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format();
    return true;
  } catch {
    return false;
  }
}, "must be a valid IANA time zone");

const schema = z.object({
  DISCORD_TOKEN: z.string().min(1),
  OPENROUTER_API_KEY: z.string().default(""),
  CLAUDE_CODE_OAUTH_TOKEN: z.string().optional(),
  CLAUDE_CODE_TIMEOUT_MS: z.coerce.number().int().min(30_000).max(900_000).default(300_000),
  DATABASE_URL: z.string().optional(),
  PORT: z.coerce.number().int().positive().default(10000),
  TIME_ZONE: timeZone,
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
  PROGRAMMER_EFFORT: reasoningEffort.default("low"),
  ENGINEER_EFFORT: reasoningEffort.default("low"),
  CREATIVE_EFFORT: reasoningEffort.default("low"),
  RESEARCHER_EFFORT: reasoningEffort.default("low"),
  COORDINATOR_EFFORT: reasoningEffort.default("low"),
  GITHUB_CLIENT_ID: z.string().optional(),
  GITHUB_CLIENT_SECRET: z.string().optional(),
  GITHUB_APP_SLUG: z.string().optional(),
  GITHUB_CALLBACK_URL: z.preprocess((value) => value === "" ? undefined : value, z.string().url().optional()),
  GITHUB_TOKEN_ENCRYPTION_KEY: z.string().optional(),
  JINA_API_KEY: z.string().optional(),
  SEARXNG_URL: z.string().optional(),
  SEARXNG_TOKEN: z.string().optional(),
  CSB_API_KEY: z.string().optional(),
  ROUTER_ENABLED: z.enum(["true", "false"]).default("true").transform((value) => value === "true"),
  ROUTER_MODELS: z.string().default("nex-agi/nex-n2.5-mini:free,inclusionai/ling-3.0-flash-sante:free,qwen/qwen3.8-27b:free,nvidia/nemotron-3.5-lightning:free,poolside/laguna-s-2.1:free"),
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
if (Boolean(env.SEARXNG_URL) !== Boolean(env.SEARXNG_TOKEN)) {
  console.error("Self-hosted web search requires SEARXNG_URL and SEARXNG_TOKEN together");
  process.exit(1);
}

export const config = {
  ...env,
  allowedChannelIds: new Set(env.ALLOWED_CHANNEL_IDS.split(",").map((v) => v.trim()).filter(Boolean)),
  ownerIds: new Set(env.OWNER_IDS.split(",").map((v) => v.trim()).filter(Boolean)),
  githubConfigured,
  claudeCodeConfigured: Boolean(env.CLAUDE_CODE_OAUTH_TOKEN),
  routerModels: env.ROUTER_MODELS.split(",").map((value) => value.trim()).filter(Boolean),
  agentChannelIds: {
    programmer: env.PROGRAMMER_CHANNEL_ID,
    engineer: env.ENGINEER_CHANNEL_ID,
    creative: env.CREATIVE_CHANNEL_ID,
    researcher: env.RESEARCHER_CHANNEL_ID,
    coordinator: env.COORDINATOR_CHANNEL_ID
  }
};
