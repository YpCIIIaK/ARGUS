import { z } from "zod";
import { agents, selectAgents, type Agent, type AgentId } from "./agents.js";
import { config } from "./config.js";

const decisionSchema = z.object({
  agents: z.array(z.enum(["programmer", "engineer", "creative", "researcher", "coordinator"])).min(1).max(2),
  tool: z.enum(["none", "web", "github", "sandbox"]),
  needsHuman: z.boolean(),
  confidence: z.number().min(0).max(1),
  reason: z.string().min(1).max(300)
});

export type RoutingDecision = z.infer<typeof decisionSchema> & { source: "rules" | "model" | "fallback"; model?: string };

export async function routeRequest(text: string, signal?: AbortSignal): Promise<{ decision: RoutingDecision; selected: Agent[] }> {
  const rules = ruleDecision(text);
  if (!config.ROUTER_ENABLED || rules.confidence >= 0.9) return resolve(rules);
  for (const model of config.routerModels) {
    try {
      const decision = await askRouter(model, text, signal);
      return resolve({ ...decision, source: "model", model });
    } catch (error) {
      console.warn(`Router model ${model} failed`, error instanceof Error ? error.message : error);
    }
  }
  const fallback = selectAgents(text).slice(0, 2).map((agent) => agent.id);
  return resolve({ agents: fallback as AgentId[], tool: inferTool(text), needsHuman: false, confidence: 0.35,
    reason: "Модели маршрутизации недоступны; использован существующий подбор ARGUS.", source: "fallback" });
}

export function ruleDecision(text: string): RoutingDecision {
  const normalized = text.toLowerCase();
  const named = agents.filter((agent) => normalized.includes(agent.name.toLowerCase()) || normalized.includes(agent.id));
  if (named.length) return { agents: named.slice(0, 2).map((agent) => agent.id), tool: inferTool(text), needsHuman: false,
    confidence: 0.99, reason: "Пользователь явно указал агента.", source: "rules" };
  const ranked = agents.map((agent) => ({ agent, score: agent.keywords.filter((word) => normalized.includes(word)).length })).sort((a, b) => b.score - a.score);
  if (ranked[0]!.score >= 2 && ranked[0]!.score > ranked[1]!.score) {
    return { agents: [ranked[0]!.agent.id], tool: inferTool(text), needsHuman: false, confidence: 0.92,
      reason: `Запрос однозначно соответствует специализации «${ranked[0]!.agent.name}».`, source: "rules" };
  }
  return { agents: ["coordinator"], tool: inferTool(text), needsHuman: false, confidence: 0.45,
    reason: "Правила не нашли однозначного исполнителя.", source: "rules" };
}

async function askRouter(model: string, text: string, signal?: AbortSignal): Promise<z.infer<typeof decisionSchema>> {
  const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${config.OPENROUTER_API_KEY}`, "Content-Type": "application/json",
      "HTTP-Referer": process.env.RENDER_EXTERNAL_URL || "http://localhost", "X-Title": "ARGUS Decision Engine" },
    body: JSON.stringify({
      model, temperature: 0, max_tokens: 300,
      messages: [
        { role: "system", content: "Ты маршрутизатор ARGUS. Верни только один JSON-объект без markdown. agents: 1-2 значения programmer|engineer|creative|researcher|coordinator; tool: none|web|github|sandbox; needsHuman: boolean; confidence: 0..1; reason: короткая причина. programmer пишет код и GitHub; engineer архитектура и диагностика; researcher веб и факты; creative идеи; coordinator план и объединение." },
        { role: "user", content: text.slice(0, 8_000) }
      ]
    }),
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(25_000)]) : AbortSignal.timeout(25_000)
  });
  const data = await response.json().catch(() => ({})) as { choices?: Array<{ message?: { content?: string } }>; error?: { message?: string } };
  if (!response.ok) throw new Error(data.error?.message || `OpenRouter returned ${response.status}`);
  const content = data.choices?.[0]?.message?.content?.trim();
  if (!content) throw new Error("empty routing response");
  const match = content.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").match(/\{[\s\S]*\}/);
  if (!match) throw new Error("routing response is not JSON");
  return decisionSchema.parse(JSON.parse(match[0]));
}

function resolve(decision: RoutingDecision) {
  const selected = decision.agents.map((id) => agents.find((agent) => agent.id === id)).filter((agent): agent is Agent => Boolean(agent));
  return { decision, selected: selected.length ? selected : [agents[4]!] };
}

function inferTool(text: string): RoutingDecision["tool"] {
  const value = text.toLowerCase();
  if (/песочниц|sandbox|запусти код|тесты|сборк/.test(value)) return "sandbox";
  if (/github|репозитор|pull request|\bpr\b/.test(value)) return "github";
  if (/найди|поищи|интернет|веб|источник|актуальн/.test(value)) return "web";
  return "none";
}
