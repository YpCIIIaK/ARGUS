import { CodeSandbox } from "@codesandbox/sdk";
import { config } from "./config.js";
import type { GithubRepositorySnapshot } from "./github.js";

const smokeTimeoutMs = 3 * 60_000;
const repositoryTimeoutMs = 10 * 60_000;
const maxOutputCharacters = 12_000;
const workspace = "/project/sandbox/argus-repo";
type CreatedSandbox = Awaited<ReturnType<CodeSandbox["sandboxes"]["create"]>>;
type SandboxSession = Awaited<ReturnType<CreatedSandbox["connect"]>>;
type SandboxCommand = Awaited<ReturnType<SandboxSession["commands"]["runBackground"]>>;

export type SandboxStep = { command: string; output: string; ok: boolean; durationMs: number };
export type SandboxRunResult = { sandboxId: string; output: string; durationMs: number; steps: SandboxStep[] };
export type SandboxProgress = (event: { type: "started" | "finished"; command: string; output?: string; ok?: boolean; durationMs?: number }) => Promise<void> | void;

export function sandboxIsConfigured() { return Boolean(config.CSB_API_KEY); }

function client() {
  if (!config.CSB_API_KEY) throw new Error("CSB_API_KEY не настроен");
  return new CodeSandbox(config.CSB_API_KEY);
}

export async function sandboxStatus() {
  if (!sandboxIsConfigured()) return { configured: false, running: 0 };
  const result = await client().sandboxes.list({ status: "running", limit: 25 });
  return { configured: true, running: result.totalCount };
}

export function detectProjectCommands(files: Array<{ path: string; content: Uint8Array }>): string[] {
  const byPath = new Map(files.map((file) => [file.path.toLowerCase(), file]));
  const packageFile = byPath.get("package.json");
  if (packageFile) {
    let scripts: Record<string, unknown> = {};
    try {
      const parsed = JSON.parse(Buffer.from(packageFile.content).toString("utf8")) as { scripts?: Record<string, unknown> };
      scripts = parsed.scripts ?? {};
    } catch { throw new Error("package.json содержит некорректный JSON."); }
    const commands = [byPath.has("pnpm-lock.yaml") ? "corepack enable && pnpm install --frozen-lockfile" :
      byPath.has("yarn.lock") ? "corepack enable && yarn install --immutable" :
        byPath.has("package-lock.json") ? "npm ci" : "npm install"];
    for (const script of ["lint", "typecheck", "test", "build"]) {
      if (typeof scripts[script] === "string") commands.push(`npm run ${script}`);
    }
    if (commands.length === 1) commands.push("node -e \"JSON.parse(require('node:fs').readFileSync('package.json','utf8'))\"");
    return commands;
  }
  if (byPath.has("pyproject.toml") || byPath.has("requirements.txt")) {
    const commands: string[] = [];
    if (byPath.has("requirements.txt")) commands.push("python -m pip install -r requirements.txt");
    if (files.some((file) => /(^|\/)test[^/]*\.py$/i.test(file.path)) || byPath.has("pytest.ini")) commands.push("python -m pytest -q");
    else commands.push("python -m compileall -q .");
    return commands;
  }
  throw new Error("Не удалось определить стек проекта. Пока поддерживаются Node.js и Python.");
}

export async function runRepositorySandbox(snapshot: GithubRepositorySnapshot, signal?: AbortSignal, onProgress?: SandboxProgress): Promise<SandboxRunResult> {
  const commands = detectProjectCommands(snapshot.files);
  return withSandbox(`ARGUS ${snapshot.repo} ${snapshot.ref}`, repositoryTimeoutMs, signal, async (session, run) => {
    await session.fs.mkdir(workspace, true);
    for (let offset = 0; offset < snapshot.files.length; offset += 20) {
      await Promise.all(snapshot.files.slice(offset, offset + 20).map(async (file) => {
        const target = `${workspace}/${file.path}`;
        const parent = target.slice(0, target.lastIndexOf("/"));
        await session.fs.mkdir(parent, true);
        await session.fs.writeFile(target, file.content, { create: true, overwrite: true });
      }));
    }
    const steps: SandboxStep[] = [];
    for (const command of commands) {
      if (signal?.aborted) throw signal.reason ?? new Error("Операция остановлена");
      await onProgress?.({ type: "started", command });
      const startedAt = Date.now();
      const result = await run(command, workspace);
      const step = { command, output: result.output, ok: result.ok, durationMs: Date.now() - startedAt };
      steps.push(step);
      await onProgress?.({ type: "finished", ...step });
      if (!step.ok) break;
    }
    return steps;
  });
}

export async function runSandboxSmokeTest(signal?: AbortSignal): Promise<SandboxRunResult> {
  return withSandbox("ARGUS smoke test", smokeTimeoutMs, signal, async (session, run) => {
    const directory = "/project/sandbox/argus-smoke";
    await session.fs.mkdir(directory, true);
    await session.fs.writeTextFile(`${directory}/check.mjs`, "import assert from 'node:assert/strict';\nassert.equal(6 * 7, 42);\nconsole.log('ARGUS_SANDBOX_OK');\n");
    const startedAt = Date.now();
    const result = await run("node check.mjs", directory);
    return [{ command: "node check.mjs", output: result.output, ok: result.ok, durationMs: Date.now() - startedAt }];
  });
}

async function withSandbox(title: string, timeoutMs: number, signal: AbortSignal | undefined,
  work: (session: SandboxSession, run: (command: string, cwd: string) => Promise<{ output: string; ok: boolean }>) => Promise<SandboxStep[]>
): Promise<SandboxRunResult> {
  const sdk = client();
  const startedAt = Date.now();
  const sandbox = await sdk.sandboxes.create({ source: "template", privacy: "private", title: `${title} ${new Date().toISOString()}`,
    description: "Temporary sandbox created by ARGUS", tags: ["argus", "temporary"], hibernationTimeoutSeconds: 300 });
  let session: SandboxSession | undefined;
  let activeCommand: SandboxCommand | undefined;
  let timer: NodeJS.Timeout | undefined;
  let timeoutReject: ((reason?: unknown) => void) | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timeoutReject = reject;
    timer = setTimeout(() => reject(new Error(`Песочница превысила лимит времени ${Math.round(timeoutMs / 60_000)} минут`)), timeoutMs);
  });
  const abort = () => {
    void activeCommand?.kill().catch(() => undefined);
    timeoutReject?.(signal?.reason ?? new Error("Операция остановлена"));
  };
  signal?.addEventListener("abort", abort, { once: true });
  try {
    if (signal?.aborted) throw signal.reason ?? new Error("Операция остановлена");
    session = await Promise.race([sandbox.connect(), timeout]);
    const run = async (command: string, cwd: string) => {
      activeCommand = await session!.commands.runBackground(command, { cwd });
      const output = await Promise.race([activeCommand.waitUntilComplete(), timeout]);
      const ok = activeCommand.status === "FINISHED";
      activeCommand = undefined;
      return { output: output.slice(-maxOutputCharacters), ok };
    };
    const steps = await work(session, run);
    return { sandboxId: sandbox.id, steps, output: steps.map((step) => `$ ${step.command}\n${step.output}`).join("\n\n").slice(-maxOutputCharacters), durationMs: Date.now() - startedAt };
  } finally {
    if (timer) clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
    await activeCommand?.kill().catch(() => undefined);
    await session?.disconnect().catch(() => undefined);
    session?.dispose();
    await sdk.sandboxes.shutdown(sandbox.id).catch((error: unknown) => console.error(`Failed to shut down sandbox ${sandbox.id}`, error));
  }
}
