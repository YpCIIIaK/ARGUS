import { CodeSandbox } from "@codesandbox/sdk";
import { config } from "./config.js";

const timeoutMs = 3 * 60_000;
const maxOutputCharacters = 12_000;
type CreatedSandbox = Awaited<ReturnType<CodeSandbox["sandboxes"]["create"]>>;
type SandboxSession = Awaited<ReturnType<CreatedSandbox["connect"]>>;

export type SandboxRunResult = {
  sandboxId: string;
  output: string;
  durationMs: number;
};

export function sandboxIsConfigured() {
  return Boolean(config.CSB_API_KEY);
}

function client() {
  if (!config.CSB_API_KEY) throw new Error("CSB_API_KEY не настроен");
  return new CodeSandbox(config.CSB_API_KEY);
}

export async function sandboxStatus() {
  if (!sandboxIsConfigured()) return { configured: false, running: 0, total: 0 };
  const result = await client().sandboxes.list({ status: "running", limit: 25 });
  return { configured: true, running: result.totalCount, total: result.totalCount };
}

export async function runSandboxSmokeTest(signal?: AbortSignal): Promise<SandboxRunResult> {
  const sdk = client();
  const startedAt = Date.now();
  const sandbox = await sdk.sandboxes.create({
    source: "template",
    privacy: "private",
    title: `ARGUS smoke test ${new Date().toISOString()}`,
    description: "Temporary sandbox created by ARGUS for a runtime smoke test",
    tags: ["argus", "temporary"],
    hibernationTimeoutSeconds: 300
  });
  let session: SandboxSession | undefined;
  let timer: NodeJS.Timeout | undefined;
  let command: Awaited<ReturnType<SandboxSession["commands"]["runBackground"]>> | undefined;
  const abort = async () => {
    await command?.kill().catch(() => undefined);
  };
  signal?.addEventListener("abort", abort, { once: true });
  try {
    if (signal?.aborted) throw signal.reason ?? new Error("Операция остановлена");
    session = await sandbox.connect();
    await session.fs.mkdir("/project/sandbox/argus-smoke", true);
    await session.fs.writeTextFile(
      "/project/sandbox/argus-smoke/check.mjs",
      "import assert from 'node:assert/strict';\nassert.equal(6 * 7, 42);\nconsole.log('ARGUS_SANDBOX_OK');\n"
    );
    command = await session.commands.runBackground("node check.mjs", { cwd: "/project/sandbox/argus-smoke" });
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        void command?.kill().catch(() => undefined);
        reject(new Error("Песочница превысила лимит времени 3 минуты"));
      }, timeoutMs);
    });
    const stopped = new Promise<never>((_, reject) => {
      signal?.addEventListener("abort", () => reject(signal.reason ?? new Error("Операция остановлена")), { once: true });
    });
    const output = await Promise.race([command.waitUntilComplete(), timeout, stopped]);
    if (command.status !== "FINISHED") throw new Error(`Команда завершилась со статусом ${command.status}: ${output}`);
    return {
      sandboxId: sandbox.id,
      output: output.slice(-maxOutputCharacters),
      durationMs: Date.now() - startedAt
    };
  } finally {
    if (timer) clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
    await session?.disconnect().catch(() => undefined);
    session?.dispose();
    await sdk.sandboxes.shutdown(sandbox.id).catch((error: unknown) => console.error(`Failed to shut down sandbox ${sandbox.id}`, error));
  }
}
