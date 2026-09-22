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
  maxTokens = 30_000,
  signal?: AbortSignal
): Promise<AgentResponse> {
  const transcript = context.map((item) => `${item.author}: ${item.content}`).join("\n");
  const request = {
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
    })
  } satisfies RequestInit;

  let response: Response | undefined;
  let data: OpenRouterResponse | undefined;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const timeout = AbortSignal.timeout(90_000);
      response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        ...request,
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout
      });
      data = (await response.json().catch(() => ({}))) as OpenRouterResponse;
      if (response.ok) break;
      if (!isRetryableStatus(response.status) || attempt === 2) {
        throw new Error(data.error?.message || `OpenRouter returned ${response.status}`);
      }
      const delayMs = retryDelay(response, attempt);
      console.warn(`OpenRouter temporary error ${response.status}; retry ${attempt + 2}/3 in ${delayMs}ms`);
      await abortableDelay(delayMs, signal);
    } catch (error) {
      if (signal?.aborted || isAbort(error)) throw error;
      if (attempt === 2 || (response && !isRetryableStatus(response.status))) throw error;
      const delayMs = 1000 * 2 ** attempt;
      console.warn(`OpenRouter network error; retry ${attempt + 2}/3 in ${delayMs}ms`);
      await abortableDelay(delayMs, signal);
      response = undefined;
      data = undefined;
    }
  }

  if (!response?.ok || !data) throw new Error("OpenRouter request failed after retries");
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

function isRetryableStatus(status: number): boolean {
  return [408, 429, 500, 502, 503, 504].includes(status);
}

function retryDelay(response: Response, attempt: number): number {
  const retryAfter = response.headers.get("retry-after");
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds)) return Math.min(Math.max(seconds * 1000, 500), 15_000);
    const dateDelay = Date.parse(retryAfter) - Date.now();
    if (Number.isFinite(dateDelay) && dateDelay > 0) return Math.min(dateDelay, 15_000);
  }
  return 1000 * 2 ** attempt;
}

function isAbort(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  if (!signal) return new Promise((resolve) => setTimeout(resolve, ms));
  if (signal.aborted) return Promise.reject(signal.reason ?? new Error("Aborted"));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason ?? new Error("Aborted"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
