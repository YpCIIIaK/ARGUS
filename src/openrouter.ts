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
};

function readText(content: string | Array<{ type?: string; text?: string }> | null | undefined): string {
  if (typeof content === "string") return content.trim();
  if (Array.isArray(content)) {
    return content.map((part) => part.text || "").join("").trim();
  }
  return "";
}

export async function askAgent(agent: Agent, context: ContextMessage[]): Promise<string> {
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
        { role: "user", content: `Текущая переписка:\n${transcript}\n\nОтветь как ${agent.name}.` }
      ],
      temperature: agent.id === "creative" ? 0.9 : 0.55,
      max_tokens: 4096,
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
  return content;
}
