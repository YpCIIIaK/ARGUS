import type { Agent } from "./agents.js";
import { config } from "./config.js";

export type ContextMessage = { author: string; content: string };

type OpenRouterResponse = {
  choices?: Array<{
    finish_reason?: string | null;
    native_finish_reason?: string | null;
    message?: {
      content?: string | Array<{ type?: string; text?: string }> | null;
      reasoning?: string | null;
    };
  }>;
  error?: { message?: string };
  model?: string;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    cost?: number;
  };
};

export type AgentResponse = {
  content: string;
  model: string;
  usage: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    costUsd: number;
  };
};

function readText(content: string | Array<{ type?: string; text?: string }> | null | undefined): string {
  if (typeof content === "string") return content.trim();
  if (Array.isArray(content)) {
    return content.map((part) => part.text || "").join("").trim();
  }
  return "";
}

export async function askAgent(
  agent: Agent,
  context: ContextMessage[],
  currentRequest: string,
  maxTokens = 30_000
): Promise<AgentResponse> {
  const transcript = context.map((item) => `${item.author}: ${item.content}`).join("\n");
  const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.OPENROUTER_API_KEY}`,
      "Content-Type": "application/json",
      "HTTP-Referer": process.env.RENDER_EXTERNAL_URL || "http://localhost",
      "X-Title": "ForumDS"
    },
    body: JSON.stringify({
      model: agent.model,
      messages: [
        { role: "system", content: agent.prompt },
        {
          role: "user",
          content: `ИСТОРИЯ ДЛЯ КОНТЕКСТА (может содержать старые завершённые темы):\n${transcript}\n\nАКТУАЛЬНЫЙ ЗАПРОС ПОЛЬЗОВАТЕЛЯ:\n${currentRequest}\n\nВыполни именно актуальный запрос как ${agent.name}. Не продолжай старую тему, если пользователь прямо не попросил об этом. Соблюдай требуемые краткость и формат буквально.`
        }
      ],
      temperature: agent.id === "creative" ? 0.9 : 0.55,
      max_tokens: maxTokens,
      reasoning: { effort: "low", exclude: true }
    }),
    signal: AbortSignal.timeout(90_000)
  });

  const data = (await response.json()) as OpenRouterResponse;
  if (!response.ok) throw new Error(data.error?.message || `OpenRouter returned ${response.status}`);
  const choice = data.choices?.[0];
  const content = readText(choice?.message?.content);
  if (!content) {
    const finishReason = choice?.native_finish_reason || choice?.finish_reason || "unknown";
    const reasoningOnly = Boolean(choice?.message?.reasoning?.trim());
    throw new Error(`OpenRouter returned an empty answer (finish_reason=${finishReason}, reasoning_only=${reasoningOnly})`);
  }
  return {
    content,
    model: data.model || agent.model,
    usage: {
      promptTokens: data.usage?.prompt_tokens ?? 0,
      completionTokens: data.usage?.completion_tokens ?? 0,
      totalTokens: data.usage?.total_tokens ?? 0,
      costUsd: data.usage?.cost ?? 0
    }
  };
}
