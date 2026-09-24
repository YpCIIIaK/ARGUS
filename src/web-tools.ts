import { config } from "./config.js";
import type { WebAction } from "./agent-actions.js";

const timeoutMs = 20_000;
const maxResultCharacters = 24_000;

export function webToolsConfigured(): boolean {
  return Boolean(config.JINA_API_KEY);
}

export async function executeWebActions(actions: WebAction[], signal?: AbortSignal): Promise<string> {
  if (!config.JINA_API_KEY) throw new Error("веб-поиск не настроен: добавьте JINA_API_KEY в Render");
  const results: string[] = [];
  for (const [index, action] of actions.entries()) {
    const endpoint = action.type === "search"
      ? `https://s.jina.ai/${encodeURIComponent(action.query)}`
      : `https://r.jina.ai/${action.url}`;
    const title = action.type === "search" ? `ПОИСК: ${action.query}` : `СТРАНИЦА: ${action.url}`;
    const response = await fetchWithTimeout(endpoint, signal);
    const body = (await response.text()).slice(0, maxResultCharacters);
    if (!response.ok) throw new Error(`Jina ${action.type} вернул ${response.status}: ${body.slice(0, 300)}`);
    results.push(`### ${index + 1}. ${title}\n${body}`);
  }
  return results.join("\n\n").slice(0, 80_000);
}

async function fetchWithTimeout(url: string, externalSignal?: AbortSignal): Promise<Response> {
  const controller = new AbortController();
  const abort = () => controller.abort(externalSignal?.reason);
  externalSignal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(() => controller.abort(new Error("web tool timeout")), timeoutMs);
  try {
    return await fetch(url, {
      headers: {
        Accept: "text/plain",
        Authorization: `Bearer ${config.JINA_API_KEY}`,
        "X-Retain-Images": "none",
        "X-Timeout": "15"
      },
      redirect: "error",
      signal: controller.signal
    });
  } finally {
    clearTimeout(timer);
    externalSignal?.removeEventListener("abort", abort);
  }
}
