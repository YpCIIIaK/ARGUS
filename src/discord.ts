import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Client,
  EmbedBuilder,
  GatewayIntentBits,
  MessageFlags,
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
import { parseAgentActions, type GeneratedFile, type GeneratedPdf } from "./agent-actions.js";
import { agents, reasoningEfforts, selectAgents, type Agent, type ReasoningEffort } from "./agents.js";
import { formatBountyRun, getBountyStatus, startBountyScan } from "./bounty.js";
import { config } from "./config.js";
import { routeRequest } from "./decision-engine.js";
import {
  applyGithubFileChanges,
  cancelGithubFileChanges,
  createGithubConnectUrl,
  disconnectGithub,
  githubConnectionStatus,
  formatGithubChecks,
  githubInstallUrl,
  githubIsConfigured,
  listGithubRepositories,
  prepareGithubFileChanges,
  previewGithubFileChanges,
  readGithubRepositorySnapshot,
  readSelectedGithubFiles,
  readGithubPullRequestContext,
  selectGithubRepository,
  selectedGithubRepository
} from "./github.js";
import { askAgent } from "./openrouter.js";
import { generatePdf, runRepositorySandbox, runSandboxSmokeTest, sandboxIsConfigured, sandboxStatus, type SandboxRunResult } from "./sandbox.js";
import { Store } from "./store.js";
import { executeWebActions, webToolsConfigured } from "./web-tools.js";

const commandPrefix = "!";
const webhookCache = new Map<string, WebhookClient>();
const channelQueues = new Map<string, Promise<void>>();
const activeRuns = new Map<string, AbortController>();
const sandboxRuns = new Map<string, { repo: string; ref: string; result?: SandboxRunResult; error?: string; startedAt: Date }>();
const maxDelegationsPerRun = 5;
const maxDelegationDepth = 3;

type AgentExecution = { agent: Agent; content: string; files: GeneratedFile[] };
type WorkflowResult = { content: string; files: GeneratedFile[] };
type WorkflowState = {
  delegations: number;
  seen: Set<string>;
  progress: string[];
};

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
    if (["!stop", "!sandbox stop"].includes(message.content.trim().toLowerCase())) {
      const active = activeRuns.get(message.channelId);
      if (!active) {
        await message.reply("В этом канале сейчас нет активной задачи.");
      } else {
        active.abort(new Error("Stopped by user"));
        await message.reply("Останавливаю текущую задачу…");
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
    void handleInteraction(interaction, store).catch(async (error) => {
      console.error("Settings interaction failed", error);
      const content = `Не удалось применить настройку: ${errorMessage(error)}`;
      if (interaction.isRepliable()) {
        if (interaction.replied || interaction.deferred) await interaction.followUp({ content, flags: MessageFlags.Ephemeral }).catch(() => undefined);
        else await interaction.reply({ content, flags: MessageFlags.Ephemeral }).catch(() => undefined);
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
  if (channelAgent) await runDiscussion(message, store, [channelAgent], text);
  else {
    const routed = await routeRequest(text);
    const names = routed.selected.map((agent) => agent.name).join(", ");
    const provider = routed.decision.source === "model" ? `модель **${routed.decision.model}**` : routed.decision.source === "rules" ? "правила" : "резервный подбор";
    await message.reply(`🧭 **ARGUS Router → ${names}** · ${provider} · уверенность **${Math.round(routed.decision.confidence * 100)}%**\n${routed.decision.reason}${routed.decision.tool !== "none" ? `\nИнструмент: **${routed.decision.tool}**` : ""}`);
    await runDiscussion(message, store, routed.selected, text);
  }
}

async function handleCommand(message: Message, store: Store) {
  const [rawCommand, ...rest] = message.content.slice(1).trim().split(/\s+/);
  const command = rawCommand?.toLowerCase();
  const channelAgent = agentForChannel(message);
  if (command === "agents") {
    const active = agents
      .map((a) => `${a.emoji} **${a.name}** — \`${runtimeAgent(store, a).model}\` — #${a.channelName}\nВозможности: ${a.capabilities.map(capabilityLabel).join(", ")}`)
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
  if (command === "github" || command === "gh") {
    await handleGithubCommand(message, store, rest);
    return;
  }
  if (command === "sandbox") {
    const action = rest[0]?.toLowerCase() || "status";
    if (action === "status") {
      try {
        const status = await sandboxStatus();
        await message.reply(status.configured
          ? `CodeSandbox подключён. Сейчас запущено VM: **${status.running}**.`
          : "CodeSandbox не настроен: добавь `CSB_API_KEY` в Render.");
      } catch (error) {
        await message.reply(`Не удалось проверить CodeSandbox: ${errorMessage(error)}`);
      }
      return;
    }
    if (action === "logs") {
      const last = sandboxRuns.get(message.channelId);
      if (!last) await message.reply("В этом канале ещё не запускали проверку репозитория.");
      else if (last.result) await sendLong(message.channel as TextChannel, formatSandboxResult(last.repo, last.ref, last.result));
      else await message.reply(`Последний запуск **${last.repo}@${last.ref}**: ${last.error ? `❌ ${last.error}` : "⏳ выполняется"}`);
      return;
    }
    if (!['test', 'run'].includes(action)) {
      await message.reply("Используй `!sandbox status`, `!sandbox test`, `!sandbox run [pr <номер>]`, `!sandbox logs` или `!sandbox stop`.");
      return;
    }
    if (!sandboxIsConfigured()) {
      await message.reply("CodeSandbox не настроен: добавь `CSB_API_KEY` в Render.");
      return;
    }
    if (!isController(message)) {
      await message.reply("Запуск платной вычислительной среды доступен владельцам и администраторам сервера.");
      return;
    }
    if (activeRuns.has(message.channelId)) {
      await message.reply("В этом канале уже выполняется задача. Используй `!stop`, если её нужно остановить.");
      return;
    }
    const controller = new AbortController();
    activeRuns.set(message.channelId, controller);
    if (action === "run") {
      try {
        await runSelectedRepositorySandbox(message, store, rest.slice(1), controller);
      } catch (error) {
        await message.reply(`Не удалось запустить проверку репозитория: ${errorMessage(error)}`);
      } finally {
        if (activeRuns.get(message.channelId) === controller) activeRuns.delete(message.channelId);
      }
      return;
    }
    await sendAsAgent(message.channel as TextChannel, runtimeAgent(store, agents[0]!), "Передаю небольшой проверочный файл в изолированную CodeSandbox VM и прошу выполнить его.");
    await message.reply("🧪 **Песочница:** создаю временную приватную VM…");
    try {
      const result = await runSandboxSmokeTest(controller.signal);
      await message.reply(`🧪 **Песочница → Инженер:** команда завершена за **${(result.durationMs / 1000).toFixed(1)} с**.\n\`\`\`text\n${result.output || "(вывод пуст)"}\n\`\`\``);
      await sendAsAgent(message.channel as TextChannel, runtimeAgent(store, agents[1]!), result.output.includes("ARGUS_SANDBOX_OK")
        ? "Проверил результат песочницы: код выполнился успешно, контрольное утверждение прошло. Временная VM остановлена."
        : "Проверка не подтвердила ожидаемый маркер успешного выполнения. Нужен разбор вывода песочницы.");
    } catch (error) {
      if (controller.signal.aborted) await message.reply("🛑 Выполнение в песочнице остановлено командой `!stop`.");
      else await message.reply(`Не удалось выполнить код в CodeSandbox: ${errorMessage(error)}`);
    } finally {
      if (activeRuns.get(message.channelId) === controller) activeRuns.delete(message.channelId);
    }
    return;
  }
  if (command === "status") {
    if (channelAgent) {
      await message.reply(await formatChannelStatus(store, message.channelId, channelAgent));
      return;
    }
    const dailyLimit = store.getNumberSetting("daily_request_limit", config.DAILY_REQUEST_LIMIT);
    await message.reply(`Состояние: **${(await store.isPaused()) ? "пауза" : "активно"}**\nЗапросов к моделям сегодня: **${await store.getRequestsToday()} / ${dailyLimit}**\nClaude Code: **${config.claudeCodeConfigured ? "подключён" : "не настроен"}**`);
    return;
  }
  if (command === "tasks" || command === "задачи") {
    const tasks = await store.listAgentTasks(message.channelId, 15);
    if (!tasks.length) {
      await message.reply("В этом канале агенты ещё не создавали подзадач.");
      return;
    }
    const icon = { running: "⏳", done: "✅", failed: "❌", cancelled: "🛑" } as const;
    await sendLong(message.channel as TextChannel, tasks.map((task) => `${icon[task.status]} **${task.requestedBy} → ${task.assignedTo}** · ID **${task.id.slice(0, 8)}**\n${task.description.slice(0, 300)}`).join("\n\n"));
    return;
  }
  if (command === "router") {
    await message.reply(`ARGUS Decision Engine: **${config.ROUTER_ENABLED ? "включён" : "выключен"}**\nПорядок моделей:\n${config.routerModels.map((model, index) => `${index + 1}. **${model}**`).join("\n")}\nОчевидные запросы обрабатываются локальными правилами без расхода API.`);
    return;
  }
  if (command === "claude") {
    await message.reply(config.claudeCodeConfigured
      ? "Claude Code настроен через **подписочный OAuth-токен**. `ANTHROPIC_API_KEY` и `ANTHROPIC_AUTH_TOKEN` удаляются перед каждым запуском. Доступны `claude-code/sonnet`, `claude-code/opus` и точная модель `claude-code/claude-opus-5-5`. После первого ответа `!status` покажет фактический model ID, возвращённый Claude Code."
      : "Claude Code не подключён: добавь секрет `CLAUDE_CODE_OAUTH_TOKEN`, созданный командой `claude setup-token`.");
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
  if (command === "model" || command === "effort") {
    if (!channelAgent) {
      await message.reply("Открой персональный канал агента, чтобы посмотреть его модель.");
      return;
    }
    const configured = runtimeAgent(store, channelAgent);
    await message.reply(`**${channelAgent.name}** использует модель \`${configured.model}\`, effort \`${configured.effort}\`.`);
    return;
  }
  if (command === "clear") {
    if (!isController(message)) {
      await message.reply("Очистка контекста доступна владельцам и администраторам сервера.");
      return;
    }
    await store.clearContext(message.channelId);
    await message.reply(channelAgent
      ? `Контекст ${channelAgent.name} очищен. Сообщения Discord не удалялись; новая сессия началась сейчас.`
      : "Контекст общего канала очищен. Сообщения Discord не удалялись; новая сессия началась сейчас.");
    return;
  }
  if (command === "purge" || command === "clearall") {
    if (!isController(message)) {
      await message.reply("Удаление сообщений доступно владельцам и администраторам сервера.");
      return;
    }
    const count = parsePurgeCount(rest[0]);
    if (count === null) {
      await message.reply("Количество должно быть целым числом от 1 до 100, например `!purge 50`.");
      return;
    }
    if (command === "clearall") await store.clearContext(message.channelId);
    const channel = message.channel as TextChannel;
    if (typeof channel.bulkDelete !== "function") {
      await message.reply("Discord не позволяет массово удалять сообщения в этом типе канала.");
      return;
    }
    try {
      const deleted = await channel.bulkDelete(count, true);
      const confirmation = await channel.send(`🧹 Удалено сообщений: **${deleted.size}**.${command === "clearall" ? " Контекст ИИ также очищен." : " Контекст ИИ сохранён."}`);
      setTimeout(() => void confirmation.delete().catch(() => undefined), 5_000).unref();
    } catch (error) {
      await message.reply(`Не удалось удалить сообщения: ${errorMessage(error)}. Проверь право бота **Manage Messages**.`);
    }
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
    if (!(await store.consumeRequest(store.getNumberSetting("daily_request_limit", config.DAILY_REQUEST_LIMIT)))) {
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
      "Команды: `!discuss <тема>`, `!tasks`, `!router`, `!claude`, `!stop`, `!sandbox status`, `!sandbox test`, `!sandbox run`, `!sandbox run pr <номер>`, `!sandbox logs`, `!sandbox stop`, `!bounty`, `!bounty <вопрос>`, `!bounty status`, `!bounty scan`, `!github connect`, `!github repos`, `!github disconnect`, `!agents`, `!settings`, `!status`, `!context`, `!model`, `!effort`, `!compact`, `!clear`, `!purge [1-100]`, `!clearall [1-100]`, `!pause`, `!resume`."
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

async function handleGithubCommand(message: Message, store: Store, args: string[]) {
  if (!githubIsConfigured()) {
    await message.reply("Интеграция GitHub ещё не настроена на Render.");
    return;
  }
  const requested = args[0]?.toLowerCase();
  const hint = requested ? ` Нажми соответствующую кнопку для команды \`${message.content.trim()}\`.` : "";
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`github:connect:${message.author.id}`).setLabel("Подключить").setEmoji("🔗").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`github:status:${message.author.id}`).setLabel("Статус").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`github:repos:${message.author.id}`).setLabel("Репозитории").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`github:disconnect:${message.author.id}`).setLabel("Отвязать").setStyle(ButtonStyle.Danger)
  );
  await message.reply({
    content: `**GitHub · ${message.author.username}**${hint}\nРезультат нажатия увидишь только ты прямо в этом канале.`,
    components: [row],
    allowedMentions: { parse: [] }
  });
}

async function runSelectedRepositorySandbox(message: Message, store: Store, args: string[], controller: AbortController) {
  const repo = selectedGithubRepository(store, message.author.id);
  if (!repo) {
    await message.reply("Сначала выбери рабочий репозиторий через `!github` → «Репозитории».");
    return;
  }
  let ref: string | undefined;
  let label = "основная ветка";
  if (args[0]?.toLowerCase() === "pr") {
    const pullNumber = Number(args[1]);
    if (!Number.isInteger(pullNumber) || pullNumber < 1) {
      await message.reply("Укажи номер: `!sandbox run pr 12`.");
      return;
    }
    const pull = await readGithubPullRequestContext(store, message.author.id, repo, pullNumber);
    ref = pull.headSha;
    label = `PR #${pull.number}`;
  } else if (args.length) {
    await message.reply("Используй `!sandbox run` или `!sandbox run pr <номер>`.");
    return;
  }
  const channel = message.channel as TextChannel;
  sandboxRuns.set(message.channelId, { repo, ref: ref || "default", startedAt: new Date() });
  await sendAsAgent(channel, runtimeAgent(store, agents[0]!), `Передаю ${label} репозитория **${repo}** в изолированную песочницу. GitHub-токен и секреты проекта в VM не передаются.`);
  try {
    await message.reply(`📦 **GitHub → Песочница:** загружаю ${label} и определяю команды проекта…`);
    const snapshot = await readGithubRepositorySnapshot(store, message.author.id, repo, ref);
    await message.reply(`🧪 **Песочница:** получено **${snapshot.files.length}** файлов (${formatBytes(snapshot.totalBytes)}).${snapshot.skippedSensitiveFiles ? ` Пропущено потенциально секретных файлов: **${snapshot.skippedSensitiveFiles}**.` : ""} Создаю временную приватную VM.`);
    const result = await runRepositorySandbox(snapshot, controller.signal, async (event) => {
      if (event.type === "started") await channel.send(`▶️ **Песочница выполняет:** ${event.command}`);
      else await channel.send(`${event.ok ? "✅" : "❌"} **Песочница завершила:** ${event.command} за **${((event.durationMs || 0) / 1000).toFixed(1)} с**\n\`\`\`text\n${safeLog(event.output || "(вывод пуст)")}\n\`\`\``);
    });
    sandboxRuns.set(message.channelId, { repo, ref: snapshot.ref, result, startedAt: new Date() });
    const ok = result.steps.every((step) => step.ok);
    await sendAsAgent(channel, runtimeAgent(store, agents[1]!), ok
      ? `Проверил полный запуск **${repo}@${snapshot.ref}**: все **${result.steps.length}** этапа(ов) прошли. Временная VM остановлена.`
      : `Проверил запуск **${repo}@${snapshot.ref}**: команда **${result.steps.find((step) => !step.ok)?.command || "unknown"}** завершилась ошибкой. Передаю лог Программисту для исправления.`);
  } catch (error) {
    const text = controller.signal.aborted ? "Операция остановлена командой пользователя." : errorMessage(error);
    sandboxRuns.set(message.channelId, { repo, ref: ref || "default", error: text, startedAt: new Date() });
    await message.reply(controller.signal.aborted ? "🛑 Выполнение в песочнице остановлено." : `Не удалось проверить репозиторий: ${text}`);
  }
}

function formatSandboxResult(repo: string, ref: string, result: SandboxRunResult) {
  const steps = result.steps.map((step) => `${step.ok ? "✅" : "❌"} ${step.command} · ${(step.durationMs / 1000).toFixed(1)} с\n${safeLog(step.output)}`).join("\n\n");
  return `**Последний запуск песочницы**\nРепозиторий: **${repo}**\nRef: **${ref}**\nОбщее время: **${(result.durationMs / 1000).toFixed(1)} с**\n\n${steps}`;
}

function safeLog(value: string) {
  return value.replace(/```/g, "''' ").slice(-1_400);
}

function formatBytes(value: number) {
  return value < 1_000_000 ? `${(value / 1_000).toFixed(1)} КБ` : `${(value / 1_000_000).toFixed(1)} МБ`;
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
  const state: WorkflowState = { delegations: 0, seen: new Set(), progress: [] };
  const progressMessage = await message.reply("⏳ ARGUS распределяет работу между агентами…");
  try {
    await (message.channel as TextChannel).sendTyping();
    for (const agent of candidates) {
      if (controller.signal.aborted) break;
      try {
        await executeAgentWorkflow({
          message,
          store,
          agent,
          task: currentRequest,
          originalRequest: currentRequest,
          extraContext,
          depth: 0,
          state,
          signal: controller.signal,
          updateProgress: () => updateWorkflowProgress(progressMessage, state),
          emit: (execution) => publishAgentExecution(message, store, execution)
        });
      } catch (error) {
        if (error instanceof DailyLimitError) {
          await message.reply("Достигнут дневной лимит запросов к моделям.");
          break;
        }
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
    const recentProgress = state.progress.slice(-8).join("\n");
    await progressMessage.edit(controller.signal.aborted
      ? `⛔ Выполнение остановлено.\n${recentProgress}`.slice(0, 1900)
      : `✅ **Выполнение завершено** · внутренних передач: **${state.delegations}**\n${recentProgress}`.slice(0, 1900)).catch(() => undefined);
    if (activeRuns.get(message.channelId) === controller) activeRuns.delete(message.channelId);
  }
}

class DailyLimitError extends Error {}

async function executeAgentWorkflow(input: {
  message: Message;
  store: Store;
  agent: Agent;
  task: string;
  originalRequest: string;
  extraContext: Array<{ author: string; content: string }>;
  depth: number;
  state: WorkflowState;
  signal: AbortSignal;
  updateProgress: () => Promise<void>;
  emit: (execution: AgentExecution) => Promise<void>;
  requestedBy?: Agent;
}): Promise<WorkflowResult> {
  const { message, store, agent, task, originalRequest, extraContext, depth, state, signal, updateProgress, emit, requestedBy } = input;
  if (signal.aborted) return { content: "", files: [] };
  const signature = `${agent.id}:${task.trim().toLowerCase().replace(/\s+/g, " ").slice(0, 500)}`;
  if (state.seen.has(signature)) {
    state.progress.push(`↩️ ${agent.emoji} ${agent.name}: повторная подзадача пропущена`);
    await updateProgress();
    return { content: "", files: [] };
  }
  state.seen.add(signature);
  state.progress.push(`⏳ ${agent.emoji} ${agent.name}: работает`);
  await updateProgress();

  const dailyLimit = store.getNumberSetting("daily_request_limit", config.DAILY_REQUEST_LIMIT);
  if (!(await store.consumeRequest(dailyLimit))) throw new DailyLimitError();
  const configuredAgent = runtimeAgent(store, agent);
  const githubRepo = agent.capabilities.includes("github_files") ? selectedGithubRepository(store, message.author.id) : null;
  const contextLimit = store.getNumberSetting(`context_limit:${agent.id}`, config.MAX_CONTEXT_MESSAGES);
  const context = [...(await store.recent(message.channelId, contextLimit)), ...extraContext];
  let result = await askAgent(
    configuredAgent,
    context,
    workflowRequest(configuredAgent, task, originalRequest, depth, githubRepo),
    store.getNumberSetting("max_output_tokens", 30_000),
    signal
  );
  await store.recordUsage({ channelId: message.channelId, agentId: agent.id, model: result.model, ...result.usage });

  let parsed = parseAgentActions(result.content, agent);
  if (parsed.webActions.length && !signal.aborted) {
    state.progress.push(`🌐 ${agent.emoji} ${agent.name}: выполняет ${parsed.webActions.length} веб-запрос(а)`);
    await updateProgress();
    const webContext = await executeWebActions(parsed.webActions, signal);
    if (!(await store.consumeRequest(dailyLimit))) throw new DailyLimitError();
    result = await askAgent(
      configuredAgent,
      context,
      `${workflowRequest(configuredAgent, task, originalRequest, depth, githubRepo)}\n\nРЕЗУЛЬТАТЫ ВЕБ-ИНСТРУМЕНТОВ:\n${webContext}\n\nТеперь дай проверенный ответ по задаче. Укажи прямые ссылки на источники, которыми воспользовался. Повторно вызывать веб-инструменты в этом запуске нельзя.`,
      store.getNumberSetting("max_output_tokens", 30_000),
      signal
    );
    await store.recordUsage({ channelId: message.channelId, agentId: agent.id, model: result.model, ...result.usage });
    parsed = parseAgentActions(result.content, { ...agent, capabilities: agent.capabilities.filter((capability) => capability !== "web_search" && capability !== "web_read") });
  }
  if (parsed.githubReads.length && githubRepo && !signal.aborted) {
    state.progress.push(`📖 ${agent.emoji} ${agent.name}: читает ${parsed.githubReads.length} файл(а) из GitHub`);
    await updateProgress();
    const files = await readSelectedGithubFiles(store, message.author.id, parsed.githubReads);
    if (!(await store.consumeRequest(dailyLimit))) throw new DailyLimitError();
    const fileContext = files.map((file) => `--- ${file.path} ---\n${file.content}`).join("\n\n").slice(0, 500_000);
    result = await askAgent(
      configuredAgent,
      context,
      `${workflowRequest(configuredAgent, task, originalRequest, depth, githubRepo)}\n\nЗАПРОШЕННЫЕ ФАЙЛЫ ИЗ GITHUB:\n${fileContext}\n\nТеперь выполни задачу. Если меняешь прочитанный файл, верни его полное новое содержимое через GITHUB_FILE. Повторно читать файлы в этом запуске нельзя.`,
      store.getNumberSetting("max_output_tokens", 30_000),
      signal
    );
    await store.recordUsage({ channelId: message.channelId, agentId: agent.id, model: result.model, ...result.usage });
    parsed = parseAgentActions(result.content, agent);
  }
  const visibleContent = requestedBy && (parsed.content || parsed.files.length || parsed.pdfs.length)
    ? `↩️ **@${requestedBy.name}**, ${parsed.content || "запрошенные файлы готовы."}`
    : parsed.content;
  if (visibleContent || parsed.files.length) await emit({ agent: configuredAgent, content: visibleContent, files: parsed.files });
  await publishGeneratedPdfs(message, store, configuredAgent, parsed.pdfs, signal, state, updateProgress);
  if (parsed.githubChanges.length) {
    try {
      const pending = await prepareGithubFileChanges(store, message.author.id, parsed.githubChanges);
      await sendGithubApproval(message, configuredAgent, pending, parsed.githubChanges);
    } catch (error) {
      await emit({ agent: configuredAgent, content: `Не удалось подготовить изменения GitHub: ${errorMessage(error)}`, files: [] });
    }
  }
  markProgressDone(state, agent, parsed.delegations.length);
  await updateProgress();

  const helperResults: Array<{ agent: Agent; result: WorkflowResult }> = [];
  for (const delegation of parsed.delegations) {
    if (signal.aborted || state.delegations >= maxDelegationsPerRun || depth >= maxDelegationDepth) break;
    const target = agents.find((item) => item.id === delegation.agentId);
    if (!target || target.id === agent.id) continue;
    state.delegations += 1;
    state.progress.push(`➡️ ${agent.name} → ${target.name}: ${delegation.task.slice(0, 100)}`);
    await updateProgress();
    await emit({
      agent: configuredAgent,
      content: `📨 **@${target.name}**, нужна помощь:\n> ${delegation.task}`,
      files: []
    });
    const tracked = await store.createAgentTask({ channelId: message.channelId, requestedBy: agent.name, assignedTo: target.name, description: delegation.task });
    try {
      const helperResult = await executeAgentWorkflow({
        ...input,
        agent: target,
        task: `Запрос от агента «${agent.name}»: ${delegation.task}`,
        depth: depth + 1,
        requestedBy: configuredAgent
      });
      helperResults.push({ agent: target, result: helperResult });
      await store.finishAgentTask(tracked.id, "done", helperResult.content);
    } catch (error) {
      await store.finishAgentTask(tracked.id, signal.aborted ? "cancelled" : "failed", errorMessage(error));
      throw error;
    }
  }

  if (helperResults.length && !signal.aborted) {
    state.progress.push(`📬 ${agent.emoji} ${agent.name}: получил результаты и готовит итог`);
    await updateProgress();
    const final = await resumeAfterDelegation({
      message,
      store,
      agent: configuredAgent,
      originalRequest,
      helperResults,
      context,
      signal
    });
    if (final.content || final.files.length) await emit({ agent: configuredAgent, ...final });
    state.progress.push(`✅ ${agent.emoji} ${agent.name}: вернул итог пользователю`);
    await updateProgress();
    return {
      content: [parsed.content, ...helperResults.map((item) => item.result.content), final.content].filter(Boolean).join("\n"),
      files: [...parsed.files, ...helperResults.flatMap((item) => item.result.files), ...final.files]
    };
  }
  return { content: parsed.content, files: parsed.files };
}

async function resumeAfterDelegation(input: {
  message: Message;
  store: Store;
  agent: Agent;
  originalRequest: string;
  helperResults: Array<{ agent: Agent; result: WorkflowResult }>;
  context: Array<{ author: string; content: string }>;
  signal: AbortSignal;
}): Promise<WorkflowResult> {
  const { message, store, agent, originalRequest, helperResults, context, signal } = input;
  const dailyLimit = store.getNumberSetting("daily_request_limit", config.DAILY_REQUEST_LIMIT);
  if (!(await store.consumeRequest(dailyLimit))) {
    return { content: "Помощники завершили работу, но дневной лимит не позволил сформировать дополнительный итог.", files: [] };
  }
  const reports = helperResults.map(({ agent: helper, result }) => {
    const fileNames = result.files.map((file) => file.name).join(", ") || "нет";
    return `${helper.name}:\n${result.content || "Ответ без текста"}\nСозданные файлы: ${fileNames}`;
  }).join("\n\n").slice(0, 20_000);
  const availableTools = agentToolReminder(agent);
  const result = await askAgent(
    agent,
    context,
    `Помощники завершили подзадачи. Их ответы:\n\n${reports}\n\nИсходная задача пользователя:\n${originalRequest}\n\nТвои инструменты всё ещё доступны на этом шаге:\n${availableTools}\n\nТеперь заверши исходную задачу, используя нужный инструмент. Не утверждай, что инструмент недоступен, если он перечислен выше. Не запрашивай новую помощь и не используй DELEGATE.`,
    store.getNumberSetting("max_output_tokens", 30_000),
    signal
  );
  await store.recordUsage({ channelId: message.channelId, agentId: agent.id, model: result.model, ...result.usage });
  const parsed = parseAgentActions(result.content, agent);
  await publishGeneratedPdfs(message, store, agent, parsed.pdfs, signal);
  return { content: `📬 **Результаты помощников получены.**\n${parsed.content}`, files: parsed.files };
}

async function publishGeneratedPdfs(
  message: Message,
  store: Store,
  agent: Agent,
  pdfs: GeneratedPdf[],
  signal: AbortSignal,
  state?: WorkflowState,
  updateProgress?: () => Promise<void>
) {
  for (const pdf of pdfs) {
    if (signal.aborted) break;
    state?.progress.push(`📄 ${agent.emoji} ${agent.name}: создаёт PDF в CodeSandbox`);
    await updateProgress?.();
    await message.reply(`📄 **${agent.name} → Песочница:** собираю **${pdf.name}** в изолированной VM…`);
    try {
      const generated = await generatePdf(pdf.content, signal);
      const sent = await (message.channel as TextChannel).send({
        content: generated.provider === "codesandbox"
          ? `✅ **Песочница → ${agent.name}:** PDF создан за **${(generated.durationMs / 1000).toFixed(1)} с**, VM остановлена.`
          : `✅ **Render PDF → ${agent.name}:** PDF создан за **${(generated.durationMs / 1000).toFixed(1)} с**.${generated.fallbackReason ? " CodeSandbox недоступен, использован безопасный резерв." : ""}`,
        files: [{ attachment: Buffer.from(generated.file), name: pdf.name }],
        allowedMentions: { parse: [] }
      });
      await store.addMessage({ channelId: message.channelId, discordMessageId: sent.id, author: agent.name, content: `Создан PDF: ${pdf.name}` });
    } catch (error) {
      await message.reply(`Не удалось создать PDF **${pdf.name}**: ${errorMessage(error)}`);
    }
  }
}

function agentToolReminder(agent: Agent): string {
  const tools = agent.capabilities.map(capabilityLabel).join(", ") || "нет инструментов";
  const protocols: string[] = [`Доступные возможности: ${tools}.`];
  if (agent.capabilities.includes("create_file")) protocols.push('[CREATE_FILE name="file.ext"]полное содержимое[/CREATE_FILE]');
  if (agent.capabilities.includes("create_pdf")) protocols.push('[CREATE_PDF name="article.pdf"]полный документ в Markdown[/CREATE_PDF]');
  if (agent.capabilities.includes("github_files")) protocols.push('[GITHUB_READ path="path"][/GITHUB_READ] и GITHUB_FILE для подтверждаемого изменения');
  if (agent.capabilities.includes("web_search")) protocols.push('[WEB_SEARCH query="запрос"][/WEB_SEARCH] и [WEB_READ url="https://..."][/WEB_READ]');
  return protocols.join("\n");
}

async function publishAgentExecution(message: Message, store: Store, execution: AgentExecution) {
  if (execution.content && execution.content !== "[PASS]" && !execution.content.startsWith("[PASS]")) {
    const sent = await sendAsAgent(message.channel as TextChannel, execution.agent, execution.content);
    await store.addMessage({ channelId: message.channelId, discordMessageId: sent.id, author: execution.agent.name, content: execution.content });
  }
  for (const file of execution.files) {
    const sent = await sendGeneratedFile(message.channel as TextChannel, execution.agent, file);
    await store.addMessage({ channelId: message.channelId, discordMessageId: sent.id, author: execution.agent.name, content: `Создан файл: ${file.name}` });
  }
}

function workflowRequest(agent: Agent, task: string, originalRequest: string, depth: number, githubRepo: string | null): string {
  const roster = agents.map((item) => `${item.id} (${item.name}): ${item.capabilities.join(", ")}`).join("; ");
  const own = agent.capabilities.length ? agent.capabilities.join(", ") : "нет инструментов";
  const createFileProtocol = agent.capabilities.includes("create_file")
    ? `\nТы можешь создать файл. Для этого выведи блок:\n[CREATE_FILE name="filename.ext"]\nполное содержимое\n[/CREATE_FILE]\nПосле блока кратко объясни, что создано.`
    : "";
  const createPdfProtocol = agent.capabilities.includes("create_pdf")
    ? `\nТы можешь создать настоящий PDF через изолированную CodeSandbox VM. Подготовь содержимое в Markdown и выведи блок:\n[CREATE_PDF name="article.pdf"]\n# Заголовок\nПолный текст документа со ссылками и разделами.\n[/CREATE_PDF]\nНе утверждай, что PDF создан, пока инструмент не вернул файл.`
    : "";
  const githubProtocol = agent.capabilities.includes("github_files") && githubRepo
    ? `\nВыбран GitHub-репозиторий ${githubRepo}. Перед изменением существующего файла запроси его содержимое блоком [GITHUB_READ path="src/file.ts"][/GITHUB_READ]. За один запуск можно прочитать до пяти файлов. После чтения ты получишь их содержимое отдельным шагом. Ты можешь предложить создание или полную замену файла блоком:\n[GITHUB_FILE action="write" path="src/file.ts"]\nполное новое содержимое файла\n[/GITHUB_FILE]\nДля удаления используй:\n[GITHUB_FILE action="delete" path="old.txt"]\n[/GITHUB_FILE]\nКаждое изменение будет показано пользователю и применится только после кнопки подтверждения в отдельную ветку. Не заменяй существующий файл, пока не прочитал его полное содержимое.`
    : agent.capabilities.includes("github_files")
      ? "\nGitHub подключаемый инструмент доступен, но рабочий репозиторий не выбран. Попроси пользователя открыть `!github` → «Репозитории» и выбрать его."
      : "";
  const webProtocol = agent.capabilities.includes("web_search") && webToolsConfigured()
    ? `\nТы можешь искать актуальные сведения в интернете блоком [WEB_SEARCH query="точный поисковый запрос"][/WEB_SEARCH] и читать конкретную публичную страницу блоком [WEB_READ url="https://example.com/page"][/WEB_READ]. Сначала запроси нужные источники, после чего получишь их содержимое отдельным шагом. За один запуск доступно до трёх поисков и пяти страниц. Не выдумывай результаты и в итоговом ответе укажи прямые ссылки.`
    : agent.capabilities.includes("web_search")
      ? "\nВеб-инструмент пока не настроен: владельцу нужно добавить JINA_API_KEY в Render."
      : "";
  return `ИСХОДНАЯ ЗАДАЧА ПОЛЬЗОВАТЕЛЯ:\n${originalRequest}\n\nТВОЯ ТЕКУЩАЯ ПОДЗАДАЧА (уровень ${depth}):\n${task}\n\nТвои возможности: ${own}.\nКоманда: ${roster}.\nЕсли для выполнения действительно нужна возможность другого агента, передай ему одну конкретную подзадачу точным блоком:\n[DELEGATE agent="programmer"]\nчто именно требуется сделать и какие данные использовать\n[/DELEGATE]\nМожно заменить programmer на engineer, creative, researcher или coordinator. Не делегируй то, что способен сделать сам. Не вызывай самого себя. Не утверждай, что помощник уже выполнил задачу.${createFileProtocol}${createPdfProtocol}${githubProtocol}${webProtocol}`;
}

async function sendGithubApproval(
  message: Message,
  agent: Agent,
  pending: { id: string; repo: string; expiresAt: Date; emptyRepository: boolean },
  changes: Array<{ action: "write" | "delete"; path: string }>
) {
  const buttons = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`github:review:${message.author.id}:${pending.id}`).setLabel("Просмотреть").setEmoji("👁️").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`github:apply:${message.author.id}:${pending.id}`).setLabel(pending.emptyRepository ? "Создать первый коммит" : "Применить в новой ветке").setEmoji("✅").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`github:cancel:${message.author.id}:${pending.id}`).setLabel("Отменить").setStyle(ButtonStyle.Danger)
  );
  await message.reply({
    content: `${agent.emoji} **${agent.name} подготовил ${changes.length} изменение(я) GitHub.**\nНазвания приватного репозитория и файлов доступны владельцу через кнопку «Просмотреть». ${pending.emptyRepository ? "Репозиторий пуст: подтверждение создаст первый коммит и основную ветку — отдельную ветку до первого коммита GitHub создать не позволяет." : "После подтверждения ARGUS создаст отдельную ветку."} Пакет действует 15 минут.`,
    components: [buttons],
    allowedMentions: { parse: [] }
  });
}

function markProgressDone(state: WorkflowState, agent: Agent, delegations: number) {
  const pending = `⏳ ${agent.emoji} ${agent.name}: работает`;
  let index = -1;
  for (let current = state.progress.length - 1; current >= 0; current -= 1) {
    if (state.progress[current] === pending) {
      index = current;
      break;
    }
  }
  if (index >= 0) state.progress[index] = `✅ ${agent.emoji} ${agent.name}: готов${delegations ? `, запросил помощь (${delegations})` : ""}`;
}

async function updateWorkflowProgress(progressMessage: Message, state: WorkflowState) {
  const lines = state.progress.slice(-15);
  await progressMessage.edit(`**Ход выполнения**\n${lines.join("\n")}`.slice(0, 1900)).catch(() => undefined);
}

async function sendGeneratedFile(channel: TextChannel, agent: Agent, file: GeneratedFile): Promise<{ id: string }> {
  return channel.send({
    content: `${agent.emoji} **${agent.name}** создал файл \`${file.name}\``,
    files: [{ attachment: Buffer.from(file.content, "utf8"), name: file.name }],
    allowedMentions: { parse: [] }
  });
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
  const savedEffort = store.getSetting(`agent_effort:${agent.id}`);
  return {
    ...agent,
    model: store.getSetting(`agent_model:${agent.id}`) || agent.model,
    effort: reasoningEfforts.includes(savedEffort as ReasoningEffort) ? savedEffort as ReasoningEffort : agent.effort
  };
}

function capabilityLabel(capability: Agent["capabilities"][number]): string {
  return ({
    create_file: "создание файлов",
    create_pdf: "создание PDF в песочнице",
    write_code: "написание кода",
    github_files: "файлы GitHub через подтверждение",
    web_search: "поиск в интернете",
    web_read: "чтение веб-страниц",
    architecture: "архитектура",
    creative_content: "креативный контент",
    research: "исследование",
    coordination: "координация"
  })[capability];
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
  const dailyLimit = store.getNumberSetting("daily_request_limit", config.DAILY_REQUEST_LIMIT);
  const requestsToday = await store.getRequestsToday();
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
        .setDescription("Выбери агента, чтобы изменить его модель или контекст. Кнопка «Общие лимиты» меняет ограничения сразу для всего сервера.")
        .addFields({
          name: "Дневной лимит моделей",
          value: `Использовано **${requestsToday} / ${dailyLimit}** запросов. Счётчик сбрасывается в 00:00 UTC. Один вызов одного агента считается одним запросом; внутренние повторы при временной ошибке отдельно не считаются.`
        })
        .setColor(0x5865f2)
    ],
    components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select), buttons]
  };
}

async function handleInteraction(interaction: Interaction, store: Store) {
  if (await handleGithubInteraction(interaction, store)) return;
  await handleSettingsInteraction(interaction, store);
}

async function handleGithubInteraction(interaction: Interaction, store: Store): Promise<boolean> {
  if ((!interaction.isButton() && !interaction.isStringSelectMenu()) || !interaction.customId.startsWith("github:")) return false;
  const [, action, ownerId, operationId] = interaction.customId.split(":");
  if (ownerId !== interaction.user.id) {
    await interaction.reply({ content: "Эта кнопка относится к GitHub-подключению другого пользователя.", flags: MessageFlags.Ephemeral });
    return true;
  }
  if (action === "connect") {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const current = await githubConnectionStatus(store, interaction.user.id);
    const url = await createGithubConnectUrl(store, interaction.user.id);
    await interaction.editReply(`${current ? `Сейчас подключён GitHub **@${current.githubLogin}**. Новая авторизация заменит привязку.\n` : ""}Персональная ссылка действует 10 минут:\n${url}\n\nНе пересылай её другим пользователям.`);
    return true;
  }
  if (action === "status") {
    const current = await githubConnectionStatus(store, interaction.user.id);
    const selected = selectedGithubRepository(store, interaction.user.id);
    await interaction.reply({
      content: current ? `Подключён GitHub **@${current.githubLogin}**.\nРабочий репозиторий: ${selected ? `\`${selected}\`` : "не выбран"}.` : "GitHub не подключён. Нажми «Подключить».",
      flags: MessageFlags.Ephemeral
    });
    return true;
  }
  if (action === "repos") {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    try {
      const repositories = await listGithubRepositories(store, interaction.user.id);
      if (!repositories.length) {
        const install = githubInstallUrl();
        await interaction.editReply(`ARGUS не видит установок или разрешённых репозиториев.${install ? `\nУстановить приложение и выбрать репозитории: ${install}` : ""}`);
        return true;
      }
      const shown = repositories.slice(0, 15);
      const lines = shown.map((repo) => `${repo.private ? "🔒" : "🌐"} [${repo.full_name}](<${repo.html_url}>) · \`${repo.default_branch}\` · Contents: **${repo.contentsPermission}** · PR: **${repo.pullRequestsPermission}**`);
      if (repositories.length > shown.length) lines.push(`…и ещё ${repositories.length - shown.length}.`);
      const select = new StringSelectMenuBuilder()
        .setCustomId(`github:select_repo:${interaction.user.id}`)
        .setPlaceholder("Выбрать рабочий репозиторий")
        .addOptions(shown.map((repo) => ({
          label: repo.full_name.slice(0, 100),
          value: repo.full_name,
          description: `${repo.private ? "Private" : "Public"} · ${repo.default_branch}`.slice(0, 100)
        })));
      await interaction.editReply({ content: `Репозитории, разрешённые GitHub App:\n${lines.join("\n")}\n\nВыбери один рабочий репозиторий:`, components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select)] });
    } catch (error) {
      await interaction.editReply(`Не удалось получить репозитории: ${errorMessage(error)}`);
    }
    return true;
  }
  if (action === "select_repo" && interaction.isStringSelectMenu()) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    try {
      const repo = interaction.values[0];
      if (!repo) throw new Error("Репозиторий не выбран.");
      await selectGithubRepository(store, interaction.user.id, repo);
      await interaction.editReply(`Рабочий репозиторий выбран: \`${repo}\`.`);
    } catch (error) {
      await interaction.editReply(`Не удалось выбрать репозиторий: ${errorMessage(error)}`);
    }
    return true;
  }
  if ((action === "review" || action === "apply" || action === "cancel") && operationId) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    try {
      if (action === "review") {
        const pending = await previewGithubFileChanges(store, interaction.user.id, operationId);
        const preview = pending.changes.map((change) => change.action === "delete"
          ? `DELETE ${change.path}\n`
          : `WRITE ${change.path}\n${"=".repeat(72)}\n${change.content || ""}\n`).join("\n");
        await interaction.editReply({
          content: `Репозиторий: \`${pending.repo}\`\nПолное предлагаемое содержимое находится во вложении.`,
          files: [{ attachment: Buffer.from(preview, "utf8"), name: "argus-github-preview.txt" }]
        });
      } else if (action === "cancel") {
        await cancelGithubFileChanges(store, interaction.user.id, operationId);
        await interaction.editReply("Изменения отменены.");
        if (interaction.message.editable) await interaction.message.edit({ content: "🚫 Пакет изменений GitHub отменён пользователем.", components: [] });
      } else {
        const result = await applyGithubFileChanges(store, interaction.user.id, operationId);
        const privateResult = result.initializedDefault
          ? `Пустой репозиторий инициализирован первым коммитом в \`${result.branch}\`. Следующее изменение уже сможет создать Pull Request.`
          : result.pullRequest
            ? `Изменения применены в \`${result.branch}\`, создан черновик Pull Request #${result.pullRequest.number}.`
            : `Изменения применены в \`${result.branch}\`, но Pull Request создать не удалось: ${result.pullRequestError || "неизвестная ошибка"}`;
        await interaction.editReply(privateResult);
        if (interaction.message.editable) {
          const components = result.pullRequest
            ? [new ActionRowBuilder<ButtonBuilder>().addComponents(
                new ButtonBuilder().setLabel(`Открыть Pull Request #${result.pullRequest.number}`).setEmoji("🔎").setStyle(ButtonStyle.Link).setURL(result.pullRequest.url),
                new ButtonBuilder().setCustomId(`github:pr_checks:${interaction.user.id}:${result.pullRequest.number}`).setLabel("Обновить проверки").setEmoji("🔄").setStyle(ButtonStyle.Secondary)
              )]
            : [];
          const outcome = result.initializedDefault
            ? `Создан первый коммит в основной ветке: [${result.branch}](<${result.url}>)`
            : result.pullRequest
              ? `Создан черновик Pull Request **#${result.pullRequest.number}** из ветки \`${result.branch}\``
              : `Ветка [${result.branch}](<${result.url}>) создана, но Pull Request не создан`;
          await interaction.message.edit({ content: `✅ Изменено файлов: **${result.changed}** в \`${result.repo}\`. ${outcome}.`, components });
        }
        if (result.pullRequest && interaction.channel?.isTextBased() && !interaction.channel.isDMBased()) {
          try {
            await runPullRequestAgentReview(interaction.channel as TextChannel, store, interaction.user.id, result.repo, result.pullRequest.number);
          } catch (error) {
            console.error("Pull Request agent review failed", error);
            await interaction.channel.send(`⚠️ Pull Request создан, но агентскую проверку запустить не удалось: ${errorMessage(error)}`);
          }
        }
      }
    } catch (error) {
      await interaction.editReply(`Не удалось обработать изменения: ${errorMessage(error)}`);
    }
    return true;
  }
  if (action === "pr_checks" && operationId) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    try {
      const repo = selectedGithubRepository(store, interaction.user.id);
      if (!repo) throw new Error("Рабочий репозиторий не выбран.");
      const context = await readGithubPullRequestContext(store, interaction.user.id, repo, Number(operationId));
      await interaction.editReply(`**Проверки PR #${context.number}**\n${formatGithubChecks(context)}`);
    } catch (error) {
      await interaction.editReply(`Не удалось обновить проверки: ${errorMessage(error)}`);
    }
    return true;
  }
  if (action === "disconnect") {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    try {
      const current = await githubConnectionStatus(store, interaction.user.id);
      if (!current) {
        await interaction.editReply("GitHub не подключён.");
        return true;
      }
      const result = await disconnectGithub(store, interaction.user.id);
      const remote = result.revoked
        ? "Авторизация также отозвана на GitHub."
        : "Локальные токены удалены, но GitHub не подтвердил удалённый отзыв. Проверь Authorized GitHub Apps в настройках GitHub.";
      await interaction.editReply(`GitHub **@${result.login}** отвязан от Discord-пользователя. ${remote}`);
    } catch (error) {
      await interaction.editReply(`Не удалось отвязать GitHub: ${errorMessage(error)}`);
    }
  }
  return true;
}

async function runPullRequestAgentReview(channel: TextChannel, store: Store, userId: string, repo: string, pullNumber: number) {
  const publish = async (agent: Agent, content: string) => {
    const sent = await sendAsAgent(channel, agent, content);
    await store.addMessage({ channelId: channel.id, discordMessageId: sent.id, author: agent.name, content });
  };
  const context = await readGithubPullRequestContext(store, userId, repo, pullNumber);
  const checks = formatGithubChecks(context);
  let sandboxSummary = "CodeSandbox не настроен — автоматическая проверка кода не запускалась.";
  if (sandboxIsConfigured()) {
    const controller = new AbortController();
    activeRuns.set(channel.id, controller);
    await publish(runtimeAgent(store, agents.find((item) => item.id === "programmer")!), `📤 Передаю код PR #${context.number} в CodeSandbox перед архитектурной проверкой.`);
    try {
      const snapshot = await readGithubRepositorySnapshot(store, userId, repo, context.headSha);
      await channel.send(`🧪 **Песочница:** загружено **${snapshot.files.length}** файлов (${formatBytes(snapshot.totalBytes)}).${snapshot.skippedSensitiveFiles ? ` Потенциально секретных файлов пропущено: **${snapshot.skippedSensitiveFiles}**.` : ""}`);
      const result = await runRepositorySandbox(snapshot, controller.signal, async (event) => {
        if (event.type === "started") await channel.send(`▶️ **Песочница выполняет:** ${event.command}`);
        else await channel.send(`${event.ok ? "✅" : "❌"} **Песочница завершила:** ${event.command} за **${((event.durationMs || 0) / 1000).toFixed(1)} с**\n\`\`\`text\n${safeLog(event.output || "(вывод пуст)")}\n\`\`\``);
      });
      sandboxRuns.set(channel.id, { repo, ref: context.headSha, result, startedAt: new Date() });
      sandboxSummary = result.steps.map((step) => `${step.ok ? "PASS" : "FAIL"}: ${step.command}\n${safeLog(step.output)}`).join("\n\n");
      await publish(runtimeAgent(store, agents.find((item) => item.id === "engineer")!), `📥 Получил результаты CodeSandbox по PR #${context.number}. VM остановлена; учитываю их в проверке архитектуры.`);
    } catch (error) {
      sandboxSummary = `Проверка CodeSandbox не завершена: ${errorMessage(error)}`;
      sandboxRuns.set(channel.id, { repo, ref: context.headSha, error: errorMessage(error), startedAt: new Date() });
      await channel.send(`⚠️ ${sandboxSummary} Агентская проверка PR продолжится с доступными данными.`);
    } finally {
      if (activeRuns.get(channel.id) === controller) activeRuns.delete(channel.id);
    }
  }
  const files = context.files.map((file) => [
    `--- ${file.filename || "unknown"} · ${file.status || "changed"} (+${file.additions ?? 0}/-${file.deletions ?? 0}) ---`,
    file.patch || "[GitHub не предоставил patch: файл может быть бинарным или diff слишком велик]"
  ].join("\n")).join("\n\n").slice(0, 80_000);
  const base = `Репозиторий: ${context.repo}\nPull Request: #${context.number} — ${context.title}\nОписание:\n${context.body || "Нет описания"}\n\nПроверки GitHub:\n${checks}\n\nРезультат CodeSandbox:\n${sandboxSummary}\n\nИзменённые файлы:\n${files}`;
  const programmer = agents.find((item) => item.id === "programmer")!;
  await publish(runtimeAgent(store, programmer), `✅ Создал черновик [Pull Request #${context.number}](<${context.url}>). Передаю изменения Инженеру и Исследователю на проверку.`);
  await channel.send({ content: `🔍 **Начинается публичная проверка [PR #${context.number}](<${context.url}>) агентами.**\n${checks}`, allowedMentions: { parse: [] } });

  const engineer = agents.find((item) => item.id === "engineer")!;
  const researcher = agents.find((item) => item.id === "researcher")!;
  const coordinator = agents.find((item) => item.id === "coordinator")!;
  const reviews: Array<{ agent: Agent; content: string }> = [];
  for (const [reviewer, task] of [
    [engineer, "Проверь архитектуру, корректность подхода, риски отказоустойчивости и тестируемость. Перечисли блокирующие и неблокирующие замечания."],
    [researcher, "Проверь фактическую корректность, зависимости, совместимость версий и сомнительные утверждения. Не делай веб-поиск без необходимости; укажи, что требует дополнительной проверки."]
  ] as Array<[Agent, string]>) {
    await publish(runtimeAgent(store, reviewer), `📥 Получил PR #${context.number} на проверку. ${task}`);
    const dailyLimit = store.getNumberSetting("daily_request_limit", config.DAILY_REQUEST_LIMIT);
    if (!(await store.consumeRequest(dailyLimit))) {
      await channel.send("Достигнут дневной лимит: дальнейшая проверка PR остановлена.");
      return;
    }
    const configured = runtimeAgent(store, reviewer);
    const response = await askAgent(configured, [], `${task}\n\n${base}`, store.getNumberSetting("max_output_tokens", 30_000));
    await store.recordUsage({ channelId: channel.id, agentId: reviewer.id, model: response.model, ...response.usage });
    reviews.push({ agent: configured, content: response.content });
    await publish(configured, `🔎 **Проверка PR #${context.number}:**\n${response.content}`);
  }

  await publish(runtimeAgent(store, coordinator), `📥 Получил заключения Инженера и Исследователя. Формирую общий вердикт по PR #${context.number}.`);
  const dailyLimit = store.getNumberSetting("daily_request_limit", config.DAILY_REQUEST_LIMIT);
  if (!(await store.consumeRequest(dailyLimit))) {
    await channel.send("Достигнут дневной лимит: Координатор не смог сформировать итог PR.");
    return;
  }
  const configuredCoordinator = runtimeAgent(store, coordinator);
  const reports = reviews.map((review) => `${review.agent.name}:\n${review.content}`).join("\n\n");
  const response = await askAgent(
    configuredCoordinator,
    [],
    `Сформируй итог проверки Pull Request. Дай один вердикт: ГОТОВ К ПРОВЕРКЕ ЧЕЛОВЕКОМ, НУЖНЫ ИСПРАВЛЕНИЯ или ОЖИДАЮТСЯ ПРОВЕРКИ. Отдельно перечисли блокирующие замечания и состояние GitHub Checks. Не утверждай, что PR смержен.\n\n${base}\n\nЗАКЛЮЧЕНИЯ АГЕНТОВ:\n${reports}`,
    store.getNumberSetting("max_output_tokens", 30_000)
  );
  await store.recordUsage({ channelId: channel.id, agentId: coordinator.id, model: response.model, ...response.usage });
  await publish(configuredCoordinator, `📋 **Итог проверки PR #${context.number}:**\n${response.content}`);
}

async function handleSettingsInteraction(interaction: Interaction, store: Store) {
  if (!interaction.isStringSelectMenu() && !interaction.isButton() && !interaction.isModalSubmit()) return;
  if (!interaction.customId.startsWith("settings:")) return;
  if (!isInteractionController(interaction)) {
    await interaction.reply({ content: "Настройки доступны владельцам и администраторам сервера.", flags: MessageFlags.Ephemeral });
    return;
  }

  if (interaction.isStringSelectMenu() && interaction.customId === "settings:agent") {
    const agent = agents.find((item) => item.id === interaction.values[0]);
    if (!agent || !interaction.guild) return;
    await interaction.reply({ ...(await buildAgentSettings(store, interaction.guild, agent)), flags: MessageFlags.Ephemeral });
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
    await interaction.reply({ content: lines.join("\n"), flags: MessageFlags.Ephemeral });
    return;
  }

  const [, action, agentId] = interaction.customId.split(":");
  const agent = agents.find((item) => item.id === agentId);

  if (interaction.isButton() && action === "model" && agent) {
    const input = new TextInputBuilder()
      .setCustomId("model")
      .setLabel("Модель OpenRouter или Claude Code")
      .setStyle(TextInputStyle.Short)
      .setRequired(true)
      .setValue(runtimeAgent(store, agent).model)
      .setPlaceholder("claude-code/sonnet");
    await interaction.showModal(
      new ModalBuilder()
        .setCustomId(`settings:model_submit:${agent.id}`)
        .setTitle(`Модель: ${agent.name}`)
        .addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(input))
    );
    return;
  }
  if (interaction.isButton() && action === "effort" && agent) {
    const input = new TextInputBuilder()
      .setCustomId("effort")
      .setLabel("Effort: none…max")
      .setStyle(TextInputStyle.Short)
      .setRequired(true)
      .setValue(runtimeAgent(store, agent).effort)
      .setPlaceholder("medium");
    await interaction.showModal(
      new ModalBuilder()
        .setCustomId(`settings:effort_submit:${agent.id}`)
        .setTitle(`Effort: ${agent.name}`)
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
    await interaction.reply({ content: `Очистить память агента **${agent.name}** и начать новую сессию? Сообщения Discord останутся.`, components: [row], flags: MessageFlags.Ephemeral });
    return;
  }
  if (interaction.isButton() && action === "compact" && agent && interaction.guild) {
    const channelId = findAgentChannelId(interaction.guild, agent);
    if (!channelId) throw new Error(`канал #${agent.channelName} не найден`);
    const context = await store.recent(channelId, 100);
    if (!context.length) {
      await interaction.reply({ content: "Контекст пока пуст — компактировать нечего.", flags: MessageFlags.Ephemeral });
      return;
    }
    if (!(await store.consumeRequest(store.getNumberSetting("daily_request_limit", config.DAILY_REQUEST_LIMIT)))) {
      await interaction.reply({ content: "Достигнут дневной лимит запросов к моделям.", flags: MessageFlags.Ephemeral });
      return;
    }
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
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
    if (!model.includes("/") || model.length > 150) throw new Error("укажи ID в формате provider/model или claude-code/sonnet");
    await store.setSetting(`agent_model:${agent.id}`, model);
    await interaction.reply({ content: `Модель агента **${agent.name}** изменена на \`${model}\`.`, flags: MessageFlags.Ephemeral });
    return;
  }
  if (interaction.isModalSubmit() && action === "effort_submit" && agent) {
    const effort = interaction.fields.getTextInputValue("effort").trim().toLowerCase() as ReasoningEffort;
    if (!reasoningEfforts.includes(effort)) throw new Error(`допустимые значения: ${reasoningEfforts.join(", ")}`);
    await store.setSetting(`agent_effort:${agent.id}`, effort);
    await interaction.reply({ content: `Effort агента **${agent.name}** изменён на \`${effort}\`.`, flags: MessageFlags.Ephemeral });
    return;
  }
  if (interaction.isModalSubmit() && action === "context_submit" && agent) {
    const limit = boundedNumber(interaction.fields.getTextInputValue("context_limit"), 4, 100, "лимит контекста");
    await store.setSetting(`context_limit:${agent.id}`, String(limit));
    await interaction.reply({ content: `Контекст агента **${agent.name}**: последние **${limit}** сообщений.`, flags: MessageFlags.Ephemeral });
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
    await interaction.reply({ content: `Лимиты сохранены для всего сервера:\n• агентов за один раунд — **${maxReplies}**;\n• вызовов агентов в сутки — **${dailyLimit}**;\n• максимум токенов одного ответа агента — **${maxTokens.toLocaleString("ru-RU")}**.`, flags: MessageFlags.Ephemeral });
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
    `Effort: \`${configured.effort}\``,
    `Лимит контекста: **${contextLimit} сообщений**`,
    stats ? `Использовано: **${stats.allTime.totalTokens.toLocaleString("ru-RU")}** токенов · **$${stats.allTime.costUsd.toFixed(6)}**` : "Статистика пока недоступна"
  ].join("\n");
  return {
    embeds: [new EmbedBuilder().setTitle(`${agent.emoji} ${agent.name}`).setDescription(description).setColor(agent.color)],
    components: [new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`settings:model:${agent.id}`).setLabel("Изменить модель").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId(`settings:effort:${agent.id}`).setLabel("Effort").setStyle(ButtonStyle.Primary),
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

export function parsePurgeCount(value?: string): number | null {
  if (!value) return 50;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= 100 ? parsed : null;
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
    `Effort: \`${configured.effort}\``,
    `Сессия: ${sessionStart}`,
    `Сообщений в контексте: **${stats.contextMessages}**`,
    `Лимит контекста: **${store.getNumberSetting(`context_limit:${agent.id}`, config.MAX_CONTEXT_MESSAGES)}**`,
    `Запросов в сессии: **${stats.session.requests}**`,
    `Токены сессии: **${stats.session.totalTokens.toLocaleString("ru-RU")}** (вход ${stats.session.promptTokens.toLocaleString("ru-RU")}, выход ${stats.session.completionTokens.toLocaleString("ru-RU")})`,
    `Стоимость сессии по данным провайдера: **$${stats.session.costUsd.toFixed(6)}**`,
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

async function sendLong(channel: TextChannel, content: string) {
  for (const part of splitDiscordMessage(content)) await channel.send({ content: part, allowedMentions: { parse: [] } });
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
