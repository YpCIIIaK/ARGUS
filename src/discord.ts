import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Client,
  EmbedBuilder,
  GatewayIntentBits,
  ModalBuilder,
  PermissionsBitField,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
  type Guild,
  type Interaction,
  type Message,
  type TextChannel,
  WebhookClient
} from "discord.js";
import { agents, selectAgents, type Agent } from "./agents.js";
import { formatBountyRun, getBountyStatus, startBountyScan } from "./bounty.js";
import { config } from "./config.js";
import { askAgent } from "./openrouter.js";
import { Store } from "./store.js";

const commandPrefix = "!";
const webhookCache = new Map<string, WebhookClient>();
const channelQueues = new Map<string, Promise<void>>();
const activeRuns = new Map<string, AbortController>();

export function createDiscordClient(store: Store) {
  const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent]
  });

  client.once("clientReady", () => console.log(`Discord connected as ${client.user?.tag}`));

  client.on("messageCreate", async (message) => {
    if (!shouldHandle(message, client.user?.id)) return;
    try {
      if (!(await store.claimEvent(message.id))) {
        console.log(`Skipping duplicate Discord event ${message.id}`);
        return;
      }
    } catch (error) {
      console.error("Failed to claim Discord event", error);
      return;
    }
    if (message.content.trim().toLowerCase() === "!stop") {
      const active = activeRuns.get(message.channelId);
      if (!active) {
        await message.reply("В этом канале сейчас нет активной генерации.");
      } else {
        active.abort(new Error("Stopped by user"));
        await message.reply("Останавливаю текущую генерацию…");
      }
      return;
    }
    const previous = channelQueues.get(message.channelId) ?? Promise.resolve();
    const next = previous
      .then(() => handleMessage(message, store))
      .catch((error) => console.error("Failed to handle message", error))
      .finally(() => {
        if (channelQueues.get(message.channelId) === next) channelQueues.delete(message.channelId);
      });
    channelQueues.set(message.channelId, next);
  });

  client.on("interactionCreate", (interaction) => {
    void handleSettingsInteraction(interaction, store).catch(async (error) => {
      console.error("Settings interaction failed", error);
      const content = `Не удалось применить настройку: ${errorMessage(error)}`;
      if (interaction.isRepliable()) {
        if (interaction.replied || interaction.deferred) await interaction.followUp({ content, ephemeral: true }).catch(() => undefined);
        else await interaction.reply({ content, ephemeral: true }).catch(() => undefined);
      }
    });
  });

  return client;
}

function shouldHandle(message: Message, botId?: string) {
  if (!message.guild || !message.content.trim()) return false;
  if (config.BOUNTY_CHANNEL_ID && message.channelId === config.BOUNTY_CHANNEL_ID) return false;
  if (message.author.bot || message.webhookId || message.author.id === botId) return false;
  if (isSettingsChannel(message) && !message.content.trim().startsWith(commandPrefix)) return false;
  if (config.allowedChannelIds.size && !config.allowedChannelIds.has(message.channelId) && !agentForChannel(message) && !isSettingsChannel(message)) return false;
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
  const channelAgent = agentForChannel(message);
  await runDiscussion(message, store, channelAgent ? [channelAgent] : selectAgents(text), text);
}

async function handleCommand(message: Message, store: Store) {
  const [rawCommand, ...rest] = message.content.slice(1).trim().split(/\s+/);
  const command = rawCommand?.toLowerCase();
  const channelAgent = agentForChannel(message);
  if (command === "agents") {
    const active = agents
      .map((a) => `${a.emoji} **${a.name}** — \`${runtimeAgent(store, a).model}\` — #${a.channelName}`)
      .join("\n");
    const bounty = config.BOUNTY_CHANNEL_ID
      ? "\n🔭 **Bounty Monitor** — изолированный источник, доступен через `!bounty`"
      : "";
    await message.reply(active + bounty);
    return;
  }
  if (command === "settings" || command === "настройки") {
    if (!isSettingsChannel(message)) {
      await message.reply("Открой канал `#настройки-⚙` и вызови там `!settings`.");
      return;
    }
    if (!isController(message)) {
      await message.reply("Панель настроек доступна владельцам и администраторам сервера.");
      return;
    }
    await message.reply(await buildSettingsPanel(store));
    return;
  }
  if (command === "status") {
    if (channelAgent) {
      await message.reply(await formatChannelStatus(store, message.channelId, channelAgent));
      return;
    }
    await message.reply(`Состояние: **${(await store.isPaused()) ? "пауза" : "активно"}**\nЗапросов к моделям сегодня: **${store.getRequestsToday()} / ${config.DAILY_REQUEST_LIMIT}**`);
    return;
  }
  if (command === "context" || command === "session") {
    if (!channelAgent) {
      await message.reply("Эта команда предназначена для персонального канала агента.");
      return;
    }
    await message.reply(await formatChannelStatus(store, message.channelId, channelAgent));
    return;
  }
  if (command === "model") {
    if (!channelAgent) {
      await message.reply("Открой персональный канал агента, чтобы посмотреть его модель.");
      return;
    }
    await message.reply(`**${channelAgent.name}** использует модель \`${runtimeAgent(store, channelAgent).model}\`.`);
    return;
  }
  if (command === "clear") {
    if (!channelAgent) {
      await message.reply("Контекст очищается отдельно в персональном канале агента.");
      return;
    }
    if (!isController(message)) {
      await message.reply("Очистка контекста доступна владельцам и администраторам сервера.");
      return;
    }
    await store.clearContext(message.channelId);
    await message.reply(`Контекст ${channelAgent.name} очищен. Сообщения в самом Discord не удалялись; новая сессия началась сейчас.`);
    return;
  }
  if (command === "compact") {
    if (!channelAgent) {
      await message.reply("Компактизация выполняется отдельно в персональном канале агента.");
      return;
    }
    const context = await store.recent(message.channelId, 100);
    if (!context.length) {
      await message.reply("Контекст пока пуст — компактировать нечего.");
      return;
    }
    if (!store.consumeRequest()) {
      await message.reply("Достигнут дневной лимит запросов к моделям.");
      return;
    }
    await message.reply("Сжимаю текущий контекст в краткую сводку…");
    try {
      const configuredAgent = runtimeAgent(store, channelAgent);
      const result = await askAgent(
        configuredAgent,
        context,
        "Сожми историю этой сессии в самостоятельную рабочую сводку. Сохрани цели, решения, важные факты, ограничения и незавершённые задачи. Удали повторы и разговорный шум. Не добавляй новых сведений.",
        store.getNumberSetting("max_output_tokens", 30_000)
      );
      await store.recordUsage({ channelId: message.channelId, agentId: channelAgent.id, model: result.model, ...result.usage });
      await store.replaceContext(message.channelId, "Сводка контекста", result.content);
      await sendAsAgent(message.channel as TextChannel, configuredAgent, `Контекст сжат:\n\n${result.content}`);
    } catch (error) {
      console.error("Context compaction failed", error);
      await message.reply(`Не удалось сжать контекст: ${errorMessage(error)}`);
    }
    return;
  }
  if (command === "help") {
    await message.reply(
      "Команды: `!discuss <тема>`, `!stop`, `!bounty`, `!bounty <вопрос>`, `!bounty status`, `!bounty scan`, `!agents`, `!settings`, `!status`, `!context`, `!model`, `!compact`, `!clear`, `!pause`, `!resume`."
    );
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
  if (command === "bounty") {
    const action = rest[0]?.toLowerCase();
    if (action === "status") {
      try {
        const run = await getBountyStatus();
        await message.reply(run ? formatBountyRun(run) : "Bounty Monitor доступен, но прогонов ещё не было.");
      } catch (error) {
        console.error("Failed to get Bounty Monitor status", error);
        await message.reply(`Не удалось получить статус Bounty Monitor: ${errorMessage(error)}`);
      }
      return;
    }
    if (action === "scan" || action === "rescan") {
      if (!isController(message)) {
        await message.reply("Запуск Bounty Monitor доступен владельцам и администраторам сервера.");
        return;
      }
      await message.reply("Запускаю Bounty Monitor. Полный прогон может занять до минуты…");
      try {
        const run = await startBountyScan();
        await message.reply(`Скан завершён. Отчёт отправлен в bounty-канал.\n${formatBountyRun(run)}`);
      } catch (error) {
        console.error("Failed to start Bounty Monitor scan", error);
        await message.reply(`Не удалось запустить Bounty Monitor: ${errorMessage(error)}`);
      }
      return;
    }
    const bountyHistory = await readBountyChannel(message);
    if (!bountyHistory.length) return;
    const question = rest.join(" ").trim();
    if (!question) {
      const latest = bountyHistory[bountyHistory.length - 1]!.content;
      await message.reply(`Последнее сообщение Bounty Monitor:\n\n${latest.slice(0, 1700)}`);
      return;
    }
    if (await store.isPaused()) {
      await message.reply("Агенты сейчас на паузе. Используй `!resume`.");
      return;
    }
    await store.addMessage({
      channelId: message.channelId,
      discordMessageId: message.id,
      author: message.member?.displayName || message.author.displayName,
      content: `Вопрос по Bounty Monitor: ${question}`
    });
    await runDiscussion(message, store, agents, question, bountyHistory);
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
    await runDiscussion(message, store, selectAgents(topic, true), topic);
    return;
  }
  await message.reply("Неизвестная команда. Используй `!help`, чтобы посмотреть доступные команды.");
}

function isController(message: Message) {
  if (config.ownerIds.has(message.author.id)) return true;
  return message.member?.permissions.has(PermissionsBitField.Flags.Administrator) ?? false;
}

async function runDiscussion(
  message: Message,
  store: Store,
  selected: Agent[],
  currentRequest: string,
  extraContext: Array<{ author: string; content: string }> = []
) {
  const controller = new AbortController();
  activeRuns.set(message.channelId, controller);
  const requestedLimit = requestedReplyLimit(currentRequest);
  const maxReplies = store.getNumberSetting("max_agent_replies", config.MAX_AGENT_REPLIES);
  const candidates = selected.slice(0, Math.min(maxReplies, requestedLimit ?? selected.length));
  try {
    await (message.channel as TextChannel).sendTyping();
    for (const agent of candidates) {
      if (controller.signal.aborted) break;
      if (!store.consumeRequest()) {
        await message.reply("Достигнут дневной лимит запросов к моделям.");
        break;
      }
      try {
        const configuredAgent = runtimeAgent(store, agent);
        const contextLimit = store.getNumberSetting(`context_limit:${agent.id}`, config.MAX_CONTEXT_MESSAGES);
        const context = [
          ...(await store.recent(message.channelId, contextLimit)),
          ...extraContext
        ];
        const result = await askAgent(
          configuredAgent,
          context,
          currentRequest,
          store.getNumberSetting("max_output_tokens", 30_000),
          controller.signal
        );
        await store.recordUsage({ channelId: message.channelId, agentId: agent.id, model: result.model, ...result.usage });
        if (result.content === "[PASS]" || result.content.startsWith("[PASS]")) continue;
        const sent = await sendAsAgent(message.channel as TextChannel, configuredAgent, result.content);
        await store.addMessage({ channelId: message.channelId, discordMessageId: sent.id, author: agent.name, content: result.content });
      } catch (error) {
        if (controller.signal.aborted || isAbortError(error)) break;
        console.error(`${agent.name} failed`, error);
        try {
          await message.reply(`Не удалось получить ответ агента «${agent.name}». Остальные агенты продолжат обсуждение.`);
        } catch (notificationError) {
          console.error("Failed to send agent error notification", notificationError);
        }
        continue;
      }
    }
  } finally {
    if (activeRuns.get(message.channelId) === controller) activeRuns.delete(message.channelId);
  }
}

async function readBountyChannel(message: Message): Promise<Array<{ author: string; content: string }>> {
  if (!config.BOUNTY_CHANNEL_ID) {
    await message.reply("Канал Bounty Monitor ещё не настроен: добавь `BOUNTY_CHANNEL_ID` в Render Environment.");
    return [];
  }
  try {
    const channel = await message.client.channels.fetch(config.BOUNTY_CHANNEL_ID);
    if (!channel || !channel.isTextBased() || channel.isDMBased()) {
      await message.reply("Не удалось открыть настроенный канал Bounty Monitor.");
      return [];
    }
    const messages = await channel.messages.fetch({ limit: 20 });
    const history = [...messages.values()]
      .filter((item) => item.content.trim())
      .sort((a, b) => a.createdTimestamp - b.createdTimestamp)
      .map((item) => ({ author: "Bounty Monitor", content: item.content.trim() }));
    if (!history.length) {
      await message.reply("Канал Bounty Monitor доступен, но в нём пока нет сообщений. Запусти ручной скан в Vercel и проверь `DISCORD_WEBHOOK_URL`.");
    }
    return history;
  } catch (error) {
    console.error("Failed to read Bounty Monitor channel", error);
    await message.reply("Не удалось прочитать канал Bounty Monitor. Проверь ID канала и права View Channel / Read Message History.");
    return [];
  }
}

function requestedReplyLimit(text: string): number | null {
  if (/\b(?:нужен|дайте|дай|только)\s+(?:один|1)\s+(?:короткий\s+)?ответ\b/iu.test(text)) return 1;
  if (/\b(?:ответь|отвечает|пусть\s+ответит)\s+(?:только\s+)?(?:один|1)\s+агент\b/iu.test(text)) return 1;
  return null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === "AbortError" || /abort|stopped/i.test(error.message));
}

function agentForChannel(message: Message): Agent | undefined {
  const byId = agents.find((agent) => config.agentChannelIds[agent.id] === message.channelId);
  if (byId) return byId;
  const channelName = "name" in message.channel ? String(message.channel.name ?? "").toLowerCase() : "";
  return agents.find((agent) => agent.channelName === channelName);
}

function runtimeAgent(store: Store, agent: Agent): Agent {
  return { ...agent, model: store.getSetting(`agent_model:${agent.id}`) || agent.model };
}

function isSettingsChannel(message: Message): boolean {
  const name = "name" in message.channel ? String(message.channel.name ?? "").toLowerCase() : "";
  return name.startsWith("настройки") || name === "settings";
}

function isInteractionController(interaction: Interaction): boolean {
  if (config.ownerIds.has(interaction.user.id)) return true;
  return interaction.memberPermissions?.has(PermissionsBitField.Flags.Administrator) ?? false;
}

async function buildSettingsPanel(store: Store) {
  const select = new StringSelectMenuBuilder()
    .setCustomId("settings:agent")
    .setPlaceholder("Выбрать агента")
    .addOptions(agents.map((agent) => ({
      label: agent.name,
      value: agent.id,
      description: `${runtimeAgent(store, agent).model}`.slice(0, 100),
      emoji: agent.emoji
    })));
  const buttons = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("settings:limits").setLabel("Общие лимиты").setEmoji("⚙️").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId("settings:usage").setLabel("Использование").setEmoji("📊").setStyle(ButtonStyle.Secondary)
  );
  return {
    embeds: [
      new EmbedBuilder()
        .setTitle("⚙️ Настройки ARGUS")
        .setDescription("Выбери агента, чтобы изменить его модель или контекст. Общие лимиты действуют на весь сервер.")
        .setColor(0x5865f2)
    ],
    components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select), buttons]
  };
}

async function handleSettingsInteraction(interaction: Interaction, store: Store) {
  if (!interaction.isStringSelectMenu() && !interaction.isButton() && !interaction.isModalSubmit()) return;
  if (!interaction.customId.startsWith("settings:")) return;
  if (!isInteractionController(interaction)) {
    await interaction.reply({ content: "Настройки доступны владельцам и администраторам сервера.", ephemeral: true });
    return;
  }

  if (interaction.isStringSelectMenu() && interaction.customId === "settings:agent") {
    const agent = agents.find((item) => item.id === interaction.values[0]);
    if (!agent || !interaction.guild) return;
    await interaction.reply({ ...(await buildAgentSettings(store, interaction.guild, agent)), ephemeral: true });
    return;
  }

  if (interaction.isButton() && interaction.customId === "settings:limits") {
    await interaction.showModal(buildLimitsModal(store));
    return;
  }
  if (interaction.isButton() && interaction.customId === "settings:usage") {
    const lines = await Promise.all(agents.map(async (agent) => {
      const channelId = interaction.guild ? findAgentChannelId(interaction.guild, agent) : undefined;
      if (!channelId) return `${agent.emoji} **${agent.name}** — канал не найден`;
      const stats = await store.usageStats(channelId);
      return `${agent.emoji} **${agent.name}** — ${stats.allTime.requests} запросов · ${stats.allTime.totalTokens.toLocaleString("ru-RU")} токенов · $${stats.allTime.costUsd.toFixed(6)}`;
    }));
    await interaction.reply({ content: lines.join("\n"), ephemeral: true });
    return;
  }

  const [, action, agentId] = interaction.customId.split(":");
  const agent = agents.find((item) => item.id === agentId);

  if (interaction.isButton() && action === "model" && agent) {
    const input = new TextInputBuilder()
      .setCustomId("model")
      .setLabel("Идентификатор модели OpenRouter")
      .setStyle(TextInputStyle.Short)
      .setRequired(true)
      .setValue(runtimeAgent(store, agent).model)
      .setPlaceholder("deepseek/deepseek-v4-flash-0731");
    await interaction.showModal(
      new ModalBuilder()
        .setCustomId(`settings:model_submit:${agent.id}`)
        .setTitle(`Модель: ${agent.name}`)
        .addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(input))
    );
    return;
  }
  if (interaction.isButton() && action === "context" && agent) {
    const value = store.getNumberSetting(`context_limit:${agent.id}`, config.MAX_CONTEXT_MESSAGES);
    const input = new TextInputBuilder()
      .setCustomId("context_limit")
      .setLabel("Сообщений в контексте (4–100)")
      .setStyle(TextInputStyle.Short)
      .setRequired(true)
      .setValue(String(value));
    await interaction.showModal(
      new ModalBuilder()
        .setCustomId(`settings:context_submit:${agent.id}`)
        .setTitle(`Контекст: ${agent.name}`)
        .addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(input))
    );
    return;
  }
  if (interaction.isButton() && action === "clear" && agent) {
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`settings:clear_confirm:${agent.id}`).setLabel("Да, очистить контекст").setStyle(ButtonStyle.Danger)
    );
    await interaction.reply({ content: `Очистить память агента **${agent.name}** и начать новую сессию? Сообщения Discord останутся.`, components: [row], ephemeral: true });
    return;
  }
  if (interaction.isButton() && action === "compact" && agent && interaction.guild) {
    const channelId = findAgentChannelId(interaction.guild, agent);
    if (!channelId) throw new Error(`канал #${agent.channelName} не найден`);
    const context = await store.recent(channelId, 100);
    if (!context.length) {
      await interaction.reply({ content: "Контекст пока пуст — компактировать нечего.", ephemeral: true });
      return;
    }
    if (!store.consumeRequest()) {
      await interaction.reply({ content: "Достигнут дневной лимит запросов к моделям.", ephemeral: true });
      return;
    }
    await interaction.deferReply({ ephemeral: true });
    const configuredAgent = runtimeAgent(store, agent);
    const result = await askAgent(
      configuredAgent,
      context,
      "Сожми историю этой сессии в самостоятельную рабочую сводку. Сохрани цели, решения, важные факты, ограничения и незавершённые задачи. Удали повторы и разговорный шум. Не добавляй новых сведений.",
      store.getNumberSetting("max_output_tokens", 30_000)
    );
    await store.recordUsage({ channelId, agentId: agent.id, model: result.model, ...result.usage });
    await store.replaceContext(channelId, "Сводка контекста", result.content);
    const channel = await interaction.guild.channels.fetch(channelId);
    if (channel?.isTextBased() && !channel.isDMBased()) {
      await sendAsAgent(channel as TextChannel, configuredAgent, `Контекст сжат:\n\n${result.content}`);
    }
    await interaction.editReply(`Контекст агента **${agent.name}** сжат до рабочей сводки.`);
    return;
  }
  if (interaction.isButton() && action === "clear_confirm" && agent && interaction.guild) {
    const channelId = findAgentChannelId(interaction.guild, agent);
    if (!channelId) throw new Error(`канал #${agent.channelName} не найден`);
    await store.clearContext(channelId);
    await interaction.update({ content: `Контекст агента **${agent.name}** очищен.`, components: [] });
    return;
  }

  if (interaction.isModalSubmit() && action === "model_submit" && agent) {
    const model = interaction.fields.getTextInputValue("model").trim();
    if (!model.includes("/") || model.length > 150) throw new Error("укажи полный ID модели OpenRouter в формате provider/model");
    await store.setSetting(`agent_model:${agent.id}`, model);
    await interaction.reply({ content: `Модель агента **${agent.name}** изменена на \`${model}\`.`, ephemeral: true });
    return;
  }
  if (interaction.isModalSubmit() && action === "context_submit" && agent) {
    const limit = boundedNumber(interaction.fields.getTextInputValue("context_limit"), 4, 100, "лимит контекста");
    await store.setSetting(`context_limit:${agent.id}`, String(limit));
    await interaction.reply({ content: `Контекст агента **${agent.name}**: последние **${limit}** сообщений.`, ephemeral: true });
    return;
  }
  if (interaction.isModalSubmit() && action === "limits_submit") {
    const maxReplies = boundedNumber(interaction.fields.getTextInputValue("max_replies"), 1, 10, "ответы за раунд");
    const dailyLimit = boundedNumber(interaction.fields.getTextInputValue("daily_limit"), 1, 10_000, "дневной лимит");
    const maxTokens = boundedNumber(interaction.fields.getTextInputValue("max_tokens"), 256, 100_000, "лимит токенов ответа");
    await Promise.all([
      store.setSetting("max_agent_replies", String(maxReplies)),
      store.setSetting("daily_request_limit", String(dailyLimit)),
      store.setSetting("max_output_tokens", String(maxTokens))
    ]);
    await interaction.reply({ content: `Лимиты сохранены: ответов за раунд ${maxReplies}, запросов в день ${dailyLimit}, токенов ответа ${maxTokens.toLocaleString("ru-RU")}.`, ephemeral: true });
  }
}

async function buildAgentSettings(store: Store, guild: Guild, agent: Agent) {
  const channelId = findAgentChannelId(guild, agent);
  const stats = channelId ? await store.usageStats(channelId) : null;
  const configured = runtimeAgent(store, agent);
  const contextLimit = store.getNumberSetting(`context_limit:${agent.id}`, config.MAX_CONTEXT_MESSAGES);
  const description = [
    `Канал: **#${agent.channelName}**${channelId ? "" : " — не найден"}`,
    `Модель: \`${configured.model}\``,
    `Лимит контекста: **${contextLimit} сообщений**`,
    stats ? `Использовано: **${stats.allTime.totalTokens.toLocaleString("ru-RU")}** токенов · **$${stats.allTime.costUsd.toFixed(6)}**` : "Статистика пока недоступна"
  ].join("\n");
  return {
    embeds: [new EmbedBuilder().setTitle(`${agent.emoji} ${agent.name}`).setDescription(description).setColor(agent.color)],
    components: [new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`settings:model:${agent.id}`).setLabel("Изменить модель").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId(`settings:context:${agent.id}`).setLabel("Контекст").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(`settings:compact:${agent.id}`).setLabel("Сжать").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`settings:clear:${agent.id}`).setLabel("Очистить").setStyle(ButtonStyle.Danger)
    )]
  };
}

function buildLimitsModal(store: Store) {
  const fields = [
    new TextInputBuilder().setCustomId("max_replies").setLabel("Ответов агентов за раунд (1–10)").setValue(String(store.getNumberSetting("max_agent_replies", config.MAX_AGENT_REPLIES))).setStyle(TextInputStyle.Short),
    new TextInputBuilder().setCustomId("daily_limit").setLabel("Запросов к моделям в день (1–10000)").setValue(String(store.getNumberSetting("daily_request_limit", config.DAILY_REQUEST_LIMIT))).setStyle(TextInputStyle.Short),
    new TextInputBuilder().setCustomId("max_tokens").setLabel("Максимум токенов ответа (256–100000)").setValue(String(store.getNumberSetting("max_output_tokens", 30_000))).setStyle(TextInputStyle.Short)
  ];
  return new ModalBuilder()
    .setCustomId("settings:limits_submit")
    .setTitle("Общие лимиты ARGUS")
    .addComponents(...fields.map((field) => new ActionRowBuilder<TextInputBuilder>().addComponents(field)));
}

function findAgentChannelId(guild: Guild, agent: Agent): string | undefined {
  const configured = config.agentChannelIds[agent.id];
  if (configured) return configured;
  return guild.channels.cache.find((channel) => channel.isTextBased() && String(channel.name).toLowerCase() === agent.channelName)?.id;
}

function boundedNumber(raw: string, min: number, max: number, label: string): number {
  const value = Number(raw.trim());
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${label}: нужно целое число от ${min} до ${max}`);
  return value;
}

async function formatChannelStatus(store: Store, channelId: string, agent: Agent): Promise<string> {
  const stats = await store.usageStats(channelId);
  const configured = runtimeAgent(store, agent);
  const sessionStart = stats.sessionStartedAt
    ? new Date(stats.sessionStartedAt).toLocaleString("ru-RU")
    : "с первого сообщения";
  const models = stats.models.length ? stats.models.join(", ") : configured.model;
  return [
    `**${agent.emoji} ${agent.name}**`,
    `Модель: \`${models}\``,
    `Сессия: ${sessionStart}`,
    `Сообщений в контексте: **${stats.contextMessages}**`,
    `Лимит контекста: **${store.getNumberSetting(`context_limit:${agent.id}`, config.MAX_CONTEXT_MESSAGES)}**`,
    `Запросов в сессии: **${stats.session.requests}**`,
    `Токены сессии: **${stats.session.totalTokens.toLocaleString("ru-RU")}** (вход ${stats.session.promptTokens.toLocaleString("ru-RU")}, выход ${stats.session.completionTokens.toLocaleString("ru-RU")})`,
    `Стоимость сессии по данным OpenRouter: **$${stats.session.costUsd.toFixed(6)}**`,
    `За всё время канала: **${stats.allTime.requests}** запросов, **${stats.allTime.totalTokens.toLocaleString("ru-RU")}** токенов, **$${stats.allTime.costUsd.toFixed(6)}**`
  ].join("\n");
}

export function splitDiscordMessage(content: string, limit = 1900): string[] {
  const text = content.trim();
  if (!text) return [];
  if (text.length <= limit) return [text];
  const parts: string[] = [];
  let remaining = text;
  while (remaining.length > limit) {
    const window = remaining.slice(0, limit + 1);
    const paragraph = window.lastIndexOf("\n\n");
    const line = window.lastIndexOf("\n");
    const space = window.lastIndexOf(" ");
    const best = Math.max(paragraph, line, space);
    const cut = best >= Math.floor(limit * 0.55) ? best : limit;
    parts.push(remaining.slice(0, cut).trimEnd());
    remaining = remaining.slice(cut).trimStart();
  }
  if (remaining) parts.push(remaining);
  return parts;
}

async function sendAsAgent(channel: TextChannel, agent: Agent, content: string): Promise<{ id: string }> {
  const parts = splitDiscordMessage(content);
  let webhook = webhookCache.get(channel.id);
  try {
    if (!webhook) {
      const hooks = await channel.fetchWebhooks();
      const existing = hooks.find((item) => item.owner?.id === channel.client.user.id && item.token);
      webhook = existing?.token
        ? new WebhookClient({ id: existing.id, token: existing.token })
        : new WebhookClient({ url: (await channel.createWebhook({ name: "ForumDS Agents" })).url });
      webhookCache.set(channel.id, webhook);
    }
  } catch (error) {
    console.warn("Webhook unavailable; falling back to a bot embed", error);
    webhook = undefined;
  }

  let lastMessage: { id: string } | undefined;
  for (const part of parts) {
    if (webhook) {
      try {
        lastMessage = await webhook.send({ content: part, username: `${agent.emoji} ${agent.name}`, allowedMentions: { parse: [] } });
        continue;
      } catch (error) {
        console.warn("Webhook send failed; using bot embeds for remaining parts", error);
        webhookCache.delete(channel.id);
        webhook.destroy();
        webhook = undefined;
      }
    }
    lastMessage = await channel.send({
      embeds: [new EmbedBuilder().setAuthor({ name: `${agent.emoji} ${agent.name}` }).setDescription(part).setColor(agent.color)],
      allowedMentions: { parse: [] }
    });
  }
  if (!lastMessage) throw new Error("Cannot send an empty agent response");
  return lastMessage;
}
