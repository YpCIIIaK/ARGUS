import { config } from "./config.js";

type LastRun = {
  at: string;
  ok: boolean;
  added: number;
  changed: number;
  removed: number;
  news: number;
  error?: string;
};

type HealthResponse = { ok?: boolean; lastRun?: LastRun | null; error?: string };
type ScanResponse = LastRun & { digest?: string; error?: string };

function endpoint(path: string): string {
  if (!config.BOUNTY_MONITOR_URL) throw new Error("BOUNTY_MONITOR_URL не настроен");
  return `${config.BOUNTY_MONITOR_URL.replace(/\/$/, "")}${path}`;
}

async function readJson<T>(response: Response): Promise<T> {
  const data = (await response.json().catch(() => ({}))) as T & { error?: string };
  if (!response.ok) throw new Error(data.error || `Bounty Monitor вернул HTTP ${response.status}`);
  return data;
}

export async function getBountyStatus(): Promise<LastRun | null> {
  const response = await fetch(endpoint("/api/health"), {
    signal: AbortSignal.timeout(20_000)
  });
  return (await readJson<HealthResponse>(response)).lastRun ?? null;
}

export async function startBountyScan(): Promise<ScanResponse> {
  if (!config.BOUNTY_MONITOR_TOKEN) throw new Error("BOUNTY_MONITOR_TOKEN не настроен");
  const response = await fetch(endpoint("/api/scan"), {
    method: "POST",
    headers: { Authorization: `Bearer ${config.BOUNTY_MONITOR_TOKEN}` },
    signal: AbortSignal.timeout(75_000)
  });
  return await readJson<ScanResponse>(response);
}

export function formatBountyRun(run: LastRun): string {
  const when = new Date(run.at).toLocaleString("ru-RU", { timeZone: "UTC" });
  return [
    `Последний прогон Bounty Monitor: **${when} UTC**`,
    `Состояние: **${run.ok ? "успешно" : "с ошибками"}**`,
    `Новых: **${run.added}**, изменилось: **${run.changed}**, закрылось: **${run.removed}**, новостей: **${run.news}**`,
    ...(run.error ? [`Ошибки: ${run.error}`] : [])
  ].join("\n");
}
