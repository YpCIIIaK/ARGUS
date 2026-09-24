import { config } from "./config.js";

export type AgentId = "programmer" | "engineer" | "creative" | "researcher" | "coordinator";
export type AgentCapability = "create_file" | "write_code" | "github_files" | "architecture" | "creative_content" | "research" | "coordination";

export type Agent = {
  id: AgentId;
  name: string;
  channelName: string;
  emoji: string;
  color: number;
  model: string;
  prompt: string;
  keywords: string[];
  capabilities: AgentCapability[];
};

const common = `Ты участник небольшого форума ИИ-агентов в Discord. Отвечай на русском языке, ясно и по делу. Актуальный запрос пользователя всегда важнее старой истории: не продолжай прошлую тему без прямой просьбы. Выполняй ограничения пользователя на число ответов, краткость и формат буквально. Учитывай сообщения других агентов, не повторяй уже сказанное. Если тебе нечего существенно добавить, ответь ровно [PASS]. Не утверждай, что выполнил внешнее действие, если у тебя нет такого инструмента. Обычно укладывайся в 1200 знаков.`;

export const agents: Agent[] = [
  {
    id: "programmer",
    name: "Программист",
    channelName: "developer",
    emoji: "💻",
    color: 0x4f8cff,
    model: config.PROGRAMMER_MODEL || config.DEFAULT_MODEL,
    keywords: ["код", "программ", "бот", "api", "база", "ошибка", "typescript", "python", "реализац"],
    capabilities: ["create_file", "write_code", "github_files"],
    prompt: `${common}\nТы Программист. Предлагай конкретную реализацию, структуру кода и технические шаги. Замечай риски безопасности и поддержки.`
  },
  {
    id: "engineer",
    name: "Инженер",
    channelName: "engineer",
    emoji: "⚙️",
    color: 0xf59e0b,
    model: config.ENGINEER_MODEL || config.DEFAULT_MODEL,
    keywords: ["архитект", "система", "огранич", "нагруз", "инжен", "хост", "сервер", "масштаб"],
    capabilities: ["architecture"],
    prompt: `${common}\nТы Инженер. Проверяй осуществимость, архитектуру, ограничения, отказоустойчивость и цену решений.`
  },
  {
    id: "creative",
    name: "Креативщик",
    channelName: "creative",
    emoji: "🎨",
    color: 0xec4899,
    model: config.CREATIVE_MODEL || config.DEFAULT_MODEL,
    keywords: ["идея", "придум", "название", "дизайн", "концеп", "креатив", "контент"],
    capabilities: ["creative_content"],
    prompt: `${common}\nТы Креативщик. Предлагай оригинальные, но осуществимые идеи, форматы и альтернативы.`
  },
  {
    id: "researcher",
    name: "Исследователь",
    channelName: "researcher",
    emoji: "🔎",
    color: 0x10b981,
    model: config.RESEARCHER_MODEL || config.DEFAULT_MODEL,
    keywords: ["исслед", "проверь", "факт", "сравни", "найди", "анализ", "источник"],
    capabilities: ["research"],
    prompt: `${common}\nТы Исследователь. Отделяй известные факты от предположений, задавай уточняющие вопросы и предлагай, что нужно проверить. Интернет-поиска у тебя пока нет.`
  },
  {
    id: "coordinator",
    name: "Координатор",
    channelName: "coordinator",
    emoji: "🧭",
    color: 0x8b5cf6,
    model: config.COORDINATOR_MODEL || config.DEFAULT_MODEL,
    keywords: ["задача", "план", "итог", "решение", "координ", "статус", "обсуд"],
    capabilities: ["coordination"],
    prompt: `${common}\nТы Координатор. Уточняй цель, соединяй предложения команды, фиксируй решения и следующие шаги.`
  }
];

export function selectAgents(text: string, explicitDiscussion = false): Agent[] {
  if (explicitDiscussion) return agents;
  const normalized = text.toLowerCase();
  const named = agents.filter((agent) => normalized.includes(agent.name.toLowerCase()) || normalized.includes(agent.id));
  if (named.length) return named;
  const ranked = agents
    .map((agent) => ({ agent, score: agent.keywords.filter((word) => normalized.includes(word)).length }))
    .sort((a, b) => b.score - a.score);
  const selected = ranked.filter((entry) => entry.score > 0).slice(0, 2).map((entry) => entry.agent);
  return selected.length ? selected : [agents[4]!, agents[2]!];
}
