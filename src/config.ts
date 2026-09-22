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
  DEFAULT_MODEL: z.string().default("openrouter/auto"),
  PROGRAMMER_MODEL: z.string().optional(),
  ENGINEER_MODEL: z.string().optional(),
  CREATIVE_MODEL: z.string().optional(),
  RESEARCHER_MODEL: z.string().optional(),
  COORDINATOR_MODEL: z.string().optional(),
  MAX_AGENT_REPLIES: z.coerce.number().int().min(1).max(10).default(4),
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

export const config = {
  ...env,
  allowedChannelIds: new Set(env.ALLOWED_CHANNEL_IDS.split(",").map((v) => v.trim()).filter(Boolean)),
  ownerIds: new Set(env.OWNER_IDS.split(",").map((v) => v.trim()).filter(Boolean))
};
