import postgres, { type Sql } from "postgres";
import { config } from "./config.js";
import type { ContextMessage } from "./openrouter.js";

type StoredMessage = ContextMessage & { channelId: string; discordMessageId: string; createdAt?: Date };

export type UsageInput = {
  channelId: string;
  agentId: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  costUsd: number;
};

export type UsageStats = {
  sessionStartedAt: string | null;
  contextMessages: number;
  session: { requests: number; promptTokens: number; completionTokens: number; totalTokens: number; costUsd: number };
  allTime: { requests: number; totalTokens: number; costUsd: number };
  models: string[];
};

export class Store {
  private sql: Sql | null = null;
  private memory: StoredMessage[] = [];
  private paused = false;
  private requestsToday = 0;
  private requestDay = new Date().toISOString().slice(0, 10);
  private usage: Array<UsageInput & { createdAt: Date }> = [];
  private sessionStarts = new Map<string, Date>();
  private settings = new Map<string, string>();
  private processedEvents = new Set<string>();

  async init() {
    if (!config.DATABASE_URL) {
      console.warn("DATABASE_URL is empty; using non-persistent in-memory storage");
      return;
    }
    this.sql = postgres(config.DATABASE_URL, { ssl: "require", max: 3 });
    await this.sql`
      create table if not exists messages (
        id bigserial primary key,
        channel_id text not null,
        discord_message_id text not null unique,
        author text not null,
        content text not null,
        created_at timestamptz not null default now()
      )
    `;
    await this.sql`
      create table if not exists app_state (
        key text primary key,
        value text not null,
        updated_at timestamptz not null default now()
      )
    `;
    await this.sql`
      create table if not exists usage_events (
        id bigserial primary key,
        channel_id text not null,
        agent_id text not null,
        model text not null,
        prompt_tokens bigint not null default 0,
        completion_tokens bigint not null default 0,
        total_tokens bigint not null default 0,
        cost_usd double precision not null default 0,
        created_at timestamptz not null default now()
      )
    `;
    await this.sql`
      create table if not exists channel_sessions (
        channel_id text primary key,
        started_at timestamptz not null default now()
      )
    `;
    await this.sql`
      create table if not exists runtime_settings (
        key text primary key,
        value text not null,
        updated_at timestamptz not null default now()
      )
    `;
    await this.sql`
      create table if not exists processed_events (
        discord_message_id text primary key,
        processed_at timestamptz not null default now()
      )
    `;
    await this.sql`delete from processed_events where processed_at < now() - interval '30 days'`;
    const settings = await this.sql<{ key: string; value: string }[]>`select key, value from runtime_settings`;
    for (const item of settings) this.settings.set(item.key, item.value);
  }

  async addMessage(message: StoredMessage) {
    if (!this.sql) {
      this.memory.push({ ...message, createdAt: new Date() });
      this.memory = this.memory.slice(-500);
      return;
    }
    await this.sql`
      insert into messages (channel_id, discord_message_id, author, content)
      values (${message.channelId}, ${message.discordMessageId}, ${message.author}, ${message.content})
      on conflict (discord_message_id) do nothing
    `;
  }

  async clearContext(channelId: string) {
    const now = new Date();
    if (!this.sql) {
      this.memory = this.memory.filter((item) => item.channelId !== channelId);
      this.sessionStarts.set(channelId, now);
      return;
    }
    await this.sql.begin(async (sql) => {
      await sql`delete from messages where channel_id = ${channelId}`;
      await sql`
        insert into channel_sessions (channel_id, started_at) values (${channelId}, ${now})
        on conflict (channel_id) do update set started_at = excluded.started_at
      `;
    });
  }

  async replaceContext(channelId: string, author: string, content: string) {
    const id = `summary-${crypto.randomUUID()}`;
    if (!this.sql) {
      this.memory = this.memory.filter((item) => item.channelId !== channelId);
      this.memory.push({ channelId, discordMessageId: id, author, content, createdAt: new Date() });
      return;
    }
    await this.sql.begin(async (sql) => {
      await sql`delete from messages where channel_id = ${channelId}`;
      await sql`
        insert into messages (channel_id, discord_message_id, author, content)
        values (${channelId}, ${id}, ${author}, ${content})
      `;
    });
  }

  async recordUsage(input: UsageInput) {
    if (!this.sql) {
      this.usage.push({ ...input, createdAt: new Date() });
      return;
    }
    await this.sql`
      insert into usage_events (
        channel_id, agent_id, model, prompt_tokens, completion_tokens, total_tokens, cost_usd
      ) values (
        ${input.channelId}, ${input.agentId}, ${input.model}, ${input.promptTokens},
        ${input.completionTokens}, ${input.totalTokens}, ${input.costUsd}
      )
    `;
  }

  async usageStats(channelId: string): Promise<UsageStats> {
    if (!this.sql) {
      const started = this.sessionStarts.get(channelId) ?? null;
      const all = this.usage.filter((item) => item.channelId === channelId);
      const session = started ? all.filter((item) => item.createdAt >= started) : all;
      return {
        sessionStartedAt: started?.toISOString() ?? null,
        contextMessages: this.memory.filter((item) => item.channelId === channelId).length,
        session: sumUsage(session),
        allTime: sumAllTime(all),
        models: [...new Set(session.map((item) => item.model))]
      };
    }
    const sessionRows = await this.sql<{ started_at: Date }[]>`
      select started_at from channel_sessions where channel_id = ${channelId}
    `;
    const started = sessionRows[0]?.started_at ?? new Date(0);
    const [counts, sessionUsage, allUsage, models] = await Promise.all([
      this.sql<{ count: string }[]>`select count(*)::text as count from messages where channel_id = ${channelId}`,
      this.sql<{ requests: string; prompt: string; completion: string; total: string; cost: number }[]>`
        select count(*)::text as requests,
          coalesce(sum(prompt_tokens), 0)::text as prompt,
          coalesce(sum(completion_tokens), 0)::text as completion,
          coalesce(sum(total_tokens), 0)::text as total,
          coalesce(sum(cost_usd), 0)::float8 as cost
        from usage_events where channel_id = ${channelId} and created_at >= ${started}
      `,
      this.sql<{ requests: string; total: string; cost: number }[]>`
        select count(*)::text as requests,
          coalesce(sum(total_tokens), 0)::text as total,
          coalesce(sum(cost_usd), 0)::float8 as cost
        from usage_events where channel_id = ${channelId}
      `,
      this.sql<{ model: string }[]>`
        select distinct model from usage_events where channel_id = ${channelId} and created_at >= ${started}
      `
    ]);
    const current = sessionUsage[0]!;
    const total = allUsage[0]!;
    return {
      sessionStartedAt: started.getTime() === 0 ? null : started.toISOString(),
      contextMessages: Number(counts[0]?.count ?? 0),
      session: {
        requests: Number(current.requests),
        promptTokens: Number(current.prompt),
        completionTokens: Number(current.completion),
        totalTokens: Number(current.total),
        costUsd: Number(current.cost)
      },
      allTime: { requests: Number(total.requests), totalTokens: Number(total.total), costUsd: Number(total.cost) },
      models: models.map((item) => item.model)
    };
  }

  getSetting(key: string): string | undefined {
    return this.settings.get(key);
  }

  getNumberSetting(key: string, fallback: number): number {
    const value = Number(this.settings.get(key));
    return Number.isFinite(value) ? value : fallback;
  }

  async setSetting(key: string, value: string) {
    this.settings.set(key, value);
    if (this.sql) await this.sql`
      insert into runtime_settings (key, value) values (${key}, ${value})
      on conflict (key) do update set value = excluded.value, updated_at = now()
    `;
  }

  async claimEvent(discordMessageId: string): Promise<boolean> {
    if (!this.sql) {
      if (this.processedEvents.has(discordMessageId)) return false;
      this.processedEvents.add(discordMessageId);
      if (this.processedEvents.size > 5000) {
        const oldest = this.processedEvents.values().next().value;
        if (oldest) this.processedEvents.delete(oldest);
      }
      return true;
    }
    const rows = await this.sql<{ discord_message_id: string }[]>`
      insert into processed_events (discord_message_id) values (${discordMessageId})
      on conflict (discord_message_id) do nothing
      returning discord_message_id
    `;
    return rows.length === 1;
  }

  async healthCheck(): Promise<{ ok: boolean; mode: "postgres" | "memory"; latencyMs: number; error?: string }> {
    const started = Date.now();
    if (!this.sql) return { ok: true, mode: "memory", latencyMs: Date.now() - started };
    try {
      await this.sql`select 1 as ok`;
      return { ok: true, mode: "postgres", latencyMs: Date.now() - started };
    } catch (error) {
      return {
        ok: false,
        mode: "postgres",
        latencyMs: Date.now() - started,
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }

  async recent(channelId: string, limit: number): Promise<ContextMessage[]> {
    if (!this.sql) return this.memory.filter((item) => item.channelId === channelId).slice(-limit);
    const rows = await this.sql<{ author: string; content: string }[]>`
      select author, content from messages
      where channel_id = ${channelId}
      order by created_at desc limit ${limit}
    `;
    return rows.reverse();
  }

  async isPaused(): Promise<boolean> {
    if (!this.sql) return this.paused;
    const rows = await this.sql<{ value: string }[]>`select value from app_state where key = 'paused'`;
    return rows[0]?.value === "true";
  }

  async setPaused(paused: boolean) {
    this.paused = paused;
    if (this.sql) await this.sql`
      insert into app_state (key, value) values ('paused', ${String(paused)})
      on conflict (key) do update set value = excluded.value, updated_at = now()
    `;
  }

  async consumeRequest(limit: number): Promise<boolean> {
    const today = new Date().toISOString().slice(0, 10);
    if (!this.sql) {
      if (today !== this.requestDay) {
        this.requestDay = today;
        this.requestsToday = 0;
      }
      if (this.requestsToday >= limit) return false;
      this.requestsToday += 1;
      return true;
    }

    const key = `request_count:${today}`;
    const rows = await this.sql<{ value: string }[]>`
      insert into app_state (key, value) values (${key}, '1')
      on conflict (key) do update
        set value = (app_state.value::integer + 1)::text, updated_at = now()
        where app_state.value::integer < ${limit}
      returning value
    `;
    return rows.length === 1;
  }

  async getRequestsToday(): Promise<number> {
    const today = new Date().toISOString().slice(0, 10);
    if (!this.sql) {
      if (today !== this.requestDay) return 0;
      return this.requestsToday;
    }
    const rows = await this.sql<{ value: string }[]>`
      select value from app_state where key = ${`request_count:${today}`}
    `;
    return Number(rows[0]?.value ?? 0);
  }
}

function sumUsage(items: Array<UsageInput>) {
  return items.reduce(
    (sum, item) => ({
      requests: sum.requests + 1,
      promptTokens: sum.promptTokens + item.promptTokens,
      completionTokens: sum.completionTokens + item.completionTokens,
      totalTokens: sum.totalTokens + item.totalTokens,
      costUsd: sum.costUsd + item.costUsd
    }),
    { requests: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0, costUsd: 0 }
  );
}

function sumAllTime(items: Array<UsageInput>) {
  return items.reduce(
    (sum, item) => ({ requests: sum.requests + 1, totalTokens: sum.totalTokens + item.totalTokens, costUsd: sum.costUsd + item.costUsd }),
    { requests: 0, totalTokens: 0, costUsd: 0 }
  );
}
