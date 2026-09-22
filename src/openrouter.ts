import type { Agent } from "./agents.js";
import { config } from "./config.js";

export type ContextMessage = { author: string; content: string };

type OpenRouterResponse = {
  choices?: Array<{ message?: { content?: string } }>;
  error?: { message?: string };
};

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
      max_tokens: 700
    }),
    signal: AbortSignal.timeout(90_000)
  });

  const data = (await response.json()) as OpenRouterResponse;
  if (!response.ok) throw new Error(data.error?.message || `OpenRouter returned ${response.status}`);
  const content = data.choices?.[0]?.message?.content?.trim();
  if (!content) throw new Error("OpenRouter returned an empty answer");
  return content;
}
