import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { config } from "./config.js";
import { safePublicUrl, type WebAction } from "./agent-actions.js";

const timeoutMs = 20_000;
const maxPageBytes = 1_000_000;
const maxResultCharacters = 24_000;

type SearxngResult = { title?: string; url?: string; content?: string; engine?: string };

export function webToolsConfigured(): boolean {
  return Boolean((config.SEARXNG_URL && config.SEARXNG_TOKEN) || config.JINA_API_KEY);
}

export async function executeWebActions(actions: WebAction[], signal?: AbortSignal): Promise<string> {
  if (!webToolsConfigured()) throw new Error("веб-поиск не настроен: подключите собственный SearXNG");
  const results: string[] = [];
  for (const [index, action] of actions.entries()) {
    const body = action.type === "search"
      ? await searchWeb(action.query, signal)
      : await readPublicPage(action.url, signal);
    const title = action.type === "search" ? `ПОИСК: ${action.query}` : `СТРАНИЦА: ${action.url}`;
    results.push(`### ${index + 1}. ${title}\n${body.slice(0, maxResultCharacters)}`);
  }
  return results.join("\n\n").slice(0, 80_000);
}

async function searchWeb(query: string, signal?: AbortSignal): Promise<string> {
  if (config.SEARXNG_URL && config.SEARXNG_TOKEN) {
    const base = /^https?:\/\//i.test(config.SEARXNG_URL) ? config.SEARXNG_URL : `http://${config.SEARXNG_URL}`;
    const url = new URL("/search", base);
    url.searchParams.set("q", query);
    url.searchParams.set("language", "auto");
    const response = await timedFetch(url, {
      headers: { Accept: "application/json", Authorization: `Bearer ${config.SEARXNG_TOKEN}` },
      signal
    });
    const body = await readLimitedBody(response);
    if (!response.ok) throw new Error(`SearXNG вернул ${response.status}: ${body.slice(0, 300)}`);
    const payload = JSON.parse(body) as { results?: SearxngResult[] };
    const items = (payload.results ?? []).slice(0, 8).map((item, i) =>
      `${i + 1}. ${item.title || "Без названия"}\n${item.url || ""}\n${item.content || ""}\nИсточник поиска: ${item.engine || "SearXNG"}`
    );
    return items.length ? items.join("\n\n") : "Поиск не вернул результатов.";
  }
  return jinaRequest(`https://s.jina.ai/${encodeURIComponent(query)}`, signal);
}

async function readPublicPage(rawUrl: string, signal?: AbortSignal): Promise<string> {
  if (!config.SEARXNG_URL && config.JINA_API_KEY) return jinaRequest(`https://r.jina.ai/${rawUrl}`, signal);
  let current = rawUrl;
  for (let redirect = 0; redirect <= 3; redirect += 1) {
    const safe = safePublicUrl(current);
    if (!safe) throw new Error("веб-адрес запрещён политикой безопасности");
    await assertPublicHost(new URL(safe).hostname);
    const response = await timedFetch(safe, {
      headers: { Accept: "text/html,text/plain,application/json;q=0.8", "User-Agent": "ARGUS-ResearchBot/1.0" },
      redirect: "manual",
      signal
    });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) throw new Error(`страница вернула перенаправление ${response.status} без адреса`);
      current = new URL(location, safe).toString();
      continue;
    }
    const body = await readLimitedBody(response);
    if (!response.ok) throw new Error(`страница вернула ${response.status}`);
    const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
    if (!/text|html|json|xml/.test(contentType)) throw new Error(`тип страницы ${contentType || "неизвестен"} не поддерживается`);
    return htmlToText(body);
  }
  throw new Error("слишком много перенаправлений");
}

async function assertPublicHost(hostname: string): Promise<void> {
  const host = hostname.replace(/^\[|\]$/g, "");
  const addresses = isIP(host) ? [{ address: host }] : await lookup(host, { all: true });
  if (!addresses.length || addresses.some(({ address }) => isPrivateAddress(address))) {
    throw new Error("адрес ведёт в локальную или служебную сеть");
  }
}

export function isPrivateAddress(address: string): boolean {
  const value = address.toLowerCase();
  const mapped = value.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)?.[1];
  const ipv4 = mapped ?? (isIP(value) === 4 ? value : null);
  if (ipv4) {
    const [a = 0, b = 0, c = 0] = ipv4.split(".").map(Number);
    return a === 0 || a === 10 || a === 127 || a >= 224
      || (a === 100 && b >= 64 && b <= 127)
      || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && (b === 0 || b === 168))
      || (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100)))
      || (a === 203 && b === 0 && c === 113);
  }
  // Public IPv6 unicast addresses currently belong to 2000::/3.
  return isIP(value) === 6 && !/^[23]/.test(value);
}

function htmlToText(value: string): string {
  return value
    .replace(/<(script|style|template|svg)\b[^>]*>[\s\S]*?<\/\1>/giu, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">").replace(/&quot;/gi, '"').replace(/&#39;/gi, "'")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxResultCharacters);
}

async function jinaRequest(url: string, signal?: AbortSignal): Promise<string> {
  const response = await timedFetch(url, {
    headers: { Accept: "text/plain", Authorization: `Bearer ${config.JINA_API_KEY}`, "X-Retain-Images": "none", "X-Timeout": "15" },
    redirect: "error",
    signal
  });
  const body = await readLimitedBody(response);
  if (!response.ok) throw new Error(`Jina вернул ${response.status}: ${body.slice(0, 300)}`);
  return body;
}

async function timedFetch(input: string | URL, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const externalSignal = init.signal;
  const abort = () => controller.abort(externalSignal?.reason);
  externalSignal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(() => controller.abort(new Error("web tool timeout")), timeoutMs);
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
    externalSignal?.removeEventListener("abort", abort);
  }
}

async function readLimitedBody(response: Response): Promise<string> {
  const declared = Number(response.headers.get("content-length") || 0);
  if (declared > maxPageBytes) throw new Error("ответ веб-сервиса слишком большой");
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxPageBytes) {
      await reader.cancel();
      throw new Error("ответ веб-сервиса слишком большой");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}
