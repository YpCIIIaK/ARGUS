import {
  Client,
  EmbedBuilder,
  GatewayIntentBits,
  PermissionsBitField,
  type Message,
  type TextChannel,
  WebhookClient
} from "discord.js";
import { agents, selectAgents, type Agent } from "./agents.js";
import { config } from "./config.js";
import { askAgent } from "./openrouter.js";
import { Store } from "./store.js";

const commandPrefix = "!";
const webhookCache = new Map<string, WebhookClient>();
const channelQueues = new Map<string, Promise<void>>();

export function createDiscordClient(store: Store) {
  const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent]
  });

  client.once("clientReady", () => console.log(`Discord connected as ${client.user?.tag}`));

  client.on("messageCreate", (message) => {
    if (!shouldHandle(message, client.user?.id)) return;
    const previous = channelQueues.get(message.channelId) ?? Promise.resolve();
    const next = previous
      .then(() => handleMessage(message, store))
      .catch((error) => console.error("Failed to handle message", error))
      .finally(() => {
        if (channelQueues.get(message.channelId) === next) channelQueues.delete(message.channelId);
      });
    channelQueues.set(message.channelId, next);
  });

  return client;
}

function shouldHandle(message: Message, botId?: string) {
  if (!message.guild || !message.content.trim()) return false;
  if (message.author.bot || message.webhookId || message.author.id === botId) return false;
  if (config.allowedChannelIds.size && !config.allowedChannelIds.has(message.channelId)) return false;
  return message.channel.isTextBased() && !message.channel.isDMBased();
}

async function handleMessage(message: Message, store: Store) {
  const text = message.content.trim();
  if (text.startsWith(commandPrefix)) {
    await handleCommand(message, store);
    return;
  }
  if (await store.isPaused()) return;

  await store.addMessage({
    channelId: message.channelId,
    discordMessageId: message.id,
    author: message.member?.displayName || message.author.displayName,
    content: text
  });
  await runDiscussion(message, store, selectAgents(text));
}

async function handleCommand(message: Message, store: Store) {
  const [rawCommand, ...rest] = message.content.slice(1).trim().split(/\s+/);
  const command = rawCommand?.toLowerCase();
  if (command === "agents") {
    await message.reply(agents.map((a) => `${a.emoji} **${a.name}** — \`${a.model}\``).join("\n"));
    return;
  }
  if (command === "status") {
    await message.reply(`Состояние: **${(await store.isPaused()) ? "пауза" : "активно"}**\nЗапросов к моделям сегодня: **${store.getRequestsToday()} / ${config.DAILY_REQUEST_LIMIT}**`);
    return;
  }
  if (command === "pause" || command === "resume") {
    if (!isController(message)) {
      await message.reply("Эта команда доступна владельцам и администраторам сервера.");
      return;
    }
    await store.setPaused(command === "pause");
    await message.reply(command === "pause" ? "Агенты поставлены на паузу." : "Агенты снова активны.");
    return;
  }
  if (command === "discuss") {
    const topic = rest.join(" ").trim();
    if (!topic) {
      await message.reply("Укажи тему: `!discuss Как нам ...` ");
      return;
    }
    if (await store.isPaused()) {
      await message.reply("Агенты сейчас на паузе. Используй `!resume`.");
      return;
    }
    await store.addMessage({ channelId: message.channelId, discordMessageId: message.id, author: message.member?.displayName || message.author.displayName, content: topic });
    await runDiscussion(message, store, selectAgents(topic, true));
    return;
  }
  await message.reply("Команды: `!discuss <тема>`, `!agents`, `!status`, `!pause`, `!resume`.");
}

function isController(message: Message) {
  if (config.ownerIds.has(message.author.id)) return true;
  return message.member?.permissions.has(PermissionsBitField.Flags.Administrator) ?? false;
}

async function runDiscussion(message: Message, store: Store, selected: Agent[]) {
  const candidates = selected.slice(0, config.MAX_AGENT_REPLIES);
  await (message.channel as TextChannel).sendTyping();
  for (const agent of candidates) {
    if (!store.consumeRequest()) {
      await message.reply("Достигнут дневной лимит запросов к моделям.");
      break;
    }
    try {
      const context = await store.recent(message.channelId, config.MAX_CONTEXT_MESSAGES);
      const answer = await askAgent(agent, context);
      if (answer === "[PASS]" || answer.startsWith("[PASS]")) continue;
      const sent = await sendAsAgent(message.channel as TextChannel, agent, answer);
      await store.addMessage({ channelId: message.channelId, discordMessageId: sent.id, author: agent.name, content: answer });
    } catch (error) {
      console.error(`${agent.name} failed`, error);
      try {
        await message.reply(`Не удалось получить ответ агента «${agent.name}». Остальные агенты продолжат обсуждение.`);
      } catch (notificationError) {
        console.error("Failed to send agent error notification", notificationError);
      }
      continue;
    }
  }
}

async function sendAsAgent(channel: TextChannel, agent: Agent, content: string) {
  try {
    let webhook = webhookCache.get(channel.id);
    if (!webhook) {
      const hooks = await channel.fetchWebhooks();
      const existing = hooks.find((item) => item.owner?.id === channel.client.user.id && item.token);
      webhook = existing?.token
        ? new WebhookClient({ id: existing.id, token: existing.token })
        : new WebhookClient({ url: (await channel.createWebhook({ name: "ForumDS Agents" })).url });
      webhookCache.set(channel.id, webhook);
    }
    return await webhook.send({ content, username: `${agent.emoji} ${agent.name}`, allowedMentions: { parse: [] } });
  } catch (error) {
    console.warn("Webhook unavailable; falling back to a bot embed", error);
    return channel.send({
      embeds: [new EmbedBuilder().setAuthor({ name: `${agent.emoji} ${agent.name}` }).setDescription(content).setColor(agent.color)],
      allowedMentions: { parse: [] }
    });
  }
}
