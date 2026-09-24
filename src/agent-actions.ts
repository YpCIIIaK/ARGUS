import type { Agent, AgentId } from "./agents.js";

const agentIds = new Set<AgentId>(["programmer", "engineer", "creative", "researcher", "coordinator"]);

export type GeneratedFile = { name: string; content: string };
export type GeneratedPdf = { name: string; content: string };
export type GithubFileChange = { action: "write" | "delete"; path: string; content?: string };
export type WebAction = { type: "search"; query: string } | { type: "read"; url: string };

export function parseAgentActions(content: string, agent: Agent): {
  content: string;
  files: GeneratedFile[];
  pdfs: GeneratedPdf[];
  delegations: Array<{ agentId: AgentId; task: string }>;
  githubChanges: GithubFileChange[];
  githubReads: string[];
  webActions: WebAction[];
} {
  const files: GeneratedFile[] = [];
  const pdfs: GeneratedPdf[] = [];
  const delegations: Array<{ agentId: AgentId; task: string }> = [];
  const githubChanges: GithubFileChange[] = [];
  const githubReads: string[] = [];
  const webActions: WebAction[] = [];
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
    /\[CREATE_PDF\s+name=["']?([^"'\]\r\n]+)["']?\]\s*([\s\S]*?)\s*\[\/CREATE_PDF\]/giu,
    (_match, rawName: string, pdfContent: string) => {
      if (agent.capabilities.includes("create_pdf") && pdfs.length < 2) {
        const base = safeFileName(rawName);
        const name = base ? (base.toLowerCase().endsWith(".pdf") ? base : `${base}.pdf`) : null;
        const bytes = Buffer.byteLength(pdfContent, "utf8");
        if (name && bytes > 0 && bytes <= 500_000) pdfs.push({ name, content: pdfContent.trim() });
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
  visible = visible.replace(
    /\[WEB_SEARCH\s+query=["']([^"'\r\n]+)["']\s*\](?:\s*\[\/WEB_SEARCH\])?/giu,
    (_match, rawQuery: string) => {
      const query = rawQuery.trim().slice(0, 500);
      if (agent.capabilities.includes("web_search") && query && webActions.filter((item) => item.type === "search").length < 3) {
        webActions.push({ type: "search", query });
      }
      return "";
    }
  );
  visible = visible.replace(
    /\[WEB_READ\s+url=["']([^"'\r\n]+)["']\s*\](?:\s*\[\/WEB_READ\])?/giu,
    (_match, rawUrl: string) => {
      const url = safePublicUrl(rawUrl);
      if (agent.capabilities.includes("web_read") && url && webActions.filter((item) => item.type === "read").length < 5) {
        webActions.push({ type: "read", url });
      }
      return "";
    }
  );
  return { content: visible.trim(), files, pdfs, delegations, githubChanges, githubReads, webActions };
}

export function safePublicUrl(raw: string): string | null {
  try {
    const url = new URL(raw.trim());
    if (!(["http:", "https:"] as string[]).includes(url.protocol) || url.username || url.password) return null;
    const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
    if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) return null;
    if (/^(127\.|10\.|0\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host)) return null;
    if (host === "::1" || host === "::" || host.startsWith("fe80:") || host.startsWith("fc") || host.startsWith("fd")) return null;
    return url.toString();
  } catch {
    return null;
  }
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
