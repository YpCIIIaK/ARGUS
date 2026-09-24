import { spawn } from "node:child_process";
import path from "node:path";
import type { Agent } from "./agents.js";
import { config } from "./config.js";
import { currentDateTimeContext, type AgentResponse, type ContextMessage } from "./openrouter.js";

type ClaudeJsonResult = {
  type?: string;
  subtype?: string;
  is_error?: boolean;
  result?: string;
  total_cost_usd?: number;
  usage?: {
    input_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
    output_tokens?: number;
  };
};

export function isClaudeCodeModel(model: string): boolean {
  return model.toLowerCase().startsWith("claude-code/");
}

export function claudeCodeModel(model: string): string {
  const selected = model.slice("claude-code/".length).trim();
  return selected || "sonnet";
}

export function parseClaudeCodeResult(stdout: string, requestedModel: string): AgentResponse {
  let data: ClaudeJsonResult;
  try {
    data = JSON.parse(stdout) as ClaudeJsonResult;
  } catch {
    throw new Error("Claude Code returned invalid JSON");
  }
  const content = data.result?.trim();
  if (data.is_error || data.subtype === "error") throw new Error(content || "Claude Code failed");
  if (!content) throw new Error("Claude Code returned an empty answer");
  const promptTokens = (data.usage?.input_tokens ?? 0)
    + (data.usage?.cache_creation_input_tokens ?? 0)
    + (data.usage?.cache_read_input_tokens ?? 0);
  const completionTokens = data.usage?.output_tokens ?? 0;
  return {
    content,
    model: `claude-code/${requestedModel}`,
    usage: {
      promptTokens,
      completionTokens,
      totalTokens: promptTokens + completionTokens,
      costUsd: data.total_cost_usd ?? 0
    }
  };
}

export async function askClaudeCode(
  agent: Agent,
  context: ContextMessage[],
  currentRequest: string,
  maxTokens: number,
  signal?: AbortSignal
): Promise<AgentResponse> {
  if (!config.CLAUDE_CODE_OAUTH_TOKEN) {
    throw new Error("Claude Code is not configured: CLAUDE_CODE_OAUTH_TOKEN is missing");
  }
  const model = claudeCodeModel(agent.model);
  const transcript = context.map((item) => `${item.author}: ${item.content}`).join("\n");
  const prompt = [
    "ИСТОРИЯ ДЛЯ КОНТЕКСТА (может содержать старые завершённые темы):",
    transcript || "(история пуста)",
    "",
    "АКТУАЛЬНЫЙ ЗАПРОС ПОЛЬЗОВАТЕЛЯ:",
    currentRequest,
    "",
    `Ответь как ${agent.name}. Выполни именно актуальный запрос. Ориентировочный предел ответа: ${maxTokens} токенов.`
  ].join("\n");
  const executable = path.join(process.cwd(), "node_modules", ".bin", process.platform === "win32" ? "claude.cmd" : "claude");
  const args = [
    "-p",
    "--output-format", "json",
    "--model", model,
    "--effort", "low",
    "--no-session-persistence",
    "--safe-mode",
    "--strict-mcp-config",
    "--tools", "",
    "--permission-prompts", "none",
    "--system-prompt", `${agent.prompt}\n\n${currentDateTimeContext()}`
  ];
  const env: NodeJS.ProcessEnv = { ...process.env, CLAUDE_CODE_OAUTH_TOKEN: config.CLAUDE_CODE_OAUTH_TOKEN };
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_AUTH_TOKEN;

  return new Promise<AgentResponse>((resolve, reject) => {
    const child = spawn(executable, args, { env, cwd: process.cwd(), windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (error?: Error, result?: AgentResponse) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      if (error) reject(error);
      else resolve(result!);
    };
    const stop = (reason: Error) => {
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 2_000).unref();
      finish(reason);
    };
    const onAbort = () => stop(signal?.reason instanceof Error ? signal.reason : new Error("Claude Code request aborted"));
    const timer = setTimeout(() => stop(new Error(`Claude Code timed out after ${config.CLAUDE_CODE_TIMEOUT_MS}ms`)), config.CLAUDE_CODE_TIMEOUT_MS);
    signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      stdout += chunk;
      if (stdout.length > 8_000_000) stop(new Error("Claude Code output exceeded 8 MB"));
    });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      stderr += chunk;
      if (stderr.length > 1_000_000) stderr = stderr.slice(-1_000_000);
    });
    child.on("error", (error) => finish(new Error(`Failed to start Claude Code: ${error.message}`)));
    child.on("close", (code) => {
      if (settled) return;
      if (code !== 0) {
        const detail = stderr.trim().slice(-1500) || `exit code ${code}`;
        finish(new Error(`Claude Code failed: ${detail}`));
        return;
      }
      try {
        finish(undefined, parseClaudeCodeResult(stdout, model));
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
      }
    });
    child.stdin.end(prompt);
  });
}
