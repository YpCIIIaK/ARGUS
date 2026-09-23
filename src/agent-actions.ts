import type { Agent, AgentId } from "./agents.js";

const agentIds = new Set<AgentId>(["programmer", "engineer", "creative", "researcher", "coordinator"]);

export type GeneratedFile = { name: string; content: string };

export function parseAgentActions(content: string, agent: Agent): {
  content: string;
  files: GeneratedFile[];
  delegations: Array<{ agentId: AgentId; task: string }>;
} {
  const files: GeneratedFile[] = [];
  const delegations: Array<{ agentId: AgentId; task: string }> = [];
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
  return { content: visible.trim(), files, delegations };
}

function safeFileName(raw: string): string | null {
  const base = raw.trim().replace(/\\/g, "/").split("/").pop()?.trim() ?? "";
  const safe = base.replace(/[^\p{L}\p{N}._ -]/gu, "_").replace(/^\.+/, "").slice(0, 100);
  return safe || null;
}
