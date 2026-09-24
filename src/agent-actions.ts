import type { Agent, AgentId } from "./agents.js";

const agentIds = new Set<AgentId>(["programmer", "engineer", "creative", "researcher", "coordinator"]);

export type GeneratedFile = { name: string; content: string };
export type GithubFileChange = { action: "write" | "delete"; path: string; content?: string };

export function parseAgentActions(content: string, agent: Agent): {
  content: string;
  files: GeneratedFile[];
  delegations: Array<{ agentId: AgentId; task: string }>;
  githubChanges: GithubFileChange[];
  githubReads: string[];
} {
  const files: GeneratedFile[] = [];
  const delegations: Array<{ agentId: AgentId; task: string }> = [];
  const githubChanges: GithubFileChange[] = [];
  const githubReads: string[] = [];
  let visible = content;

  visible = visible.replace(
    /\[CREATE_FILE\s+name=["']?([^"'\]\r\n]+)["']?\]\s*([\s\S]*?)\s*\[\/CREATE_FILE\]/giu,
    (_match, rawName: string, fileContent: string) => {
      if (agent.capabilities.includes("create_file") && files.length < 3) {
        const name = safeFileName(rawName);
        const bytes = Buffer.byteLength(fileContent, "utf8");
        if (name && bytes > 0 && bytes <= 1_000_000) files.push({ name, content: fileContent });
      }
      return "";
    }
  );
  visible = visible.replace(
    /\[DELEGATE\s+agent=["']?([a-z]+)["']?\]\s*([\s\S]*?)\s*\[\/DELEGATE\]/giu,
    (_match, rawAgentId: string, delegatedTask: string) => {
      const targetId = rawAgentId.toLowerCase() as AgentId;
      const cleanTask = delegatedTask.trim();
      if (agentIds.has(targetId) && cleanTask && delegations.length < 2) delegations.push({ agentId: targetId, task: cleanTask });
      return "";
    }
  );
  visible = visible.replace(
    /\[GITHUB_FILE\s+action=["']?(write|delete)["']?\s+path=["']([^"'\r\n]+)["']\]\s*([\s\S]*?)\s*\[\/GITHUB_FILE\]/giu,
    (_match, rawAction: string, rawPath: string, fileContent: string) => {
      if (agent.capabilities.includes("github_files") && githubChanges.length < 10) {
        const path = safeRepositoryPath(rawPath);
        const action = rawAction.toLowerCase() as "write" | "delete";
        if (path && (action === "delete" || Buffer.byteLength(fileContent, "utf8") <= 1_000_000)) {
          githubChanges.push(action === "write" ? { action, path, content: fileContent } : { action, path });
        }
      }
      return "";
    }
  );
  visible = visible.replace(
    /\[GITHUB_READ\s+path=["']([^"'\r\n]+)["']\s*\](?:\s*\[\/GITHUB_READ\])?/giu,
    (_match, rawPath: string) => {
      if (agent.capabilities.includes("github_files") && githubReads.length < 5) {
        const path = safeRepositoryPath(rawPath);
        if (path && !githubReads.includes(path)) githubReads.push(path);
      }
      return "";
    }
  );
  return { content: visible.trim(), files, delegations, githubChanges, githubReads };
}

function safeFileName(raw: string): string | null {
  const base = raw.trim().replace(/\\/g, "/").split("/").pop()?.trim() ?? "";
  const safe = base.replace(/[^\p{L}\p{N}._ -]/gu, "_").replace(/^\.+/, "").slice(0, 100);
  return safe || null;
}

function safeRepositoryPath(raw: string): string | null {
  const normalized = raw.trim().replace(/\\/g, "/").replace(/^\/+/, "");
  const parts = normalized.split("/");
  if (!normalized || parts.some((part) => !part || part === "." || part === ".." || part.includes("\0"))) return null;
  if (normalized.length > 500 || /(^|\/)(\.env(?:\.|$)|\.git\/|id_rsa$|id_ed25519$)/iu.test(normalized)) return null;
  return normalized;
}
