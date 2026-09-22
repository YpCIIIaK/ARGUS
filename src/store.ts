import postgres, { type Sql } from "postgres";
import { config } from "./config.js";
import type { ContextMessage } from "./openrouter.js";

type StoredMessage = ContextMessage & { channelId: string; discordMessageId: string };

export class Store {
  private sql: Sql | null = null;
  private memory: StoredMessage[] = [];
  private paused = false;
  private requestsToday = 0;
  private requestDay = new Date().toISOString().slice(0, 10);

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
  }

  async addMessage(message: StoredMessage) {
    if (!this.sql) {
      this.memory.push(message);
      this.memory = this.memory.slice(-500);
      return;
    }
    await this.sql`
      insert into messages (channel_id, discord_message_id, author, content)
      values (${message.channelId}, ${message.discordMessageId}, ${message.author}, ${message.content})
      on conflict (discord_message_id) do nothing
    `;
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

  consumeRequest(): boolean {
    const today = new Date().toISOString().slice(0, 10);
    if (today !== this.requestDay) {
      this.requestDay = today;
      this.requestsToday = 0;
    }
    if (this.requestsToday >= config.DAILY_REQUEST_LIMIT) return false;
    this.requestsToday += 1;
    return true;
  }

  getRequestsToday() {
    return this.requestsToday;
  }
}
