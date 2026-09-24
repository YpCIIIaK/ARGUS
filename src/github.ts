import { createHash, randomBytes } from "node:crypto";
import { config } from "./config.js";
import type { GithubFileChange } from "./agent-actions.js";
import { decodeEncryptionKey, decryptSecret, encryptSecret } from "./secret-box.js";
import { Store, type GithubConnection } from "./store.js";

const githubApi = "https://api.github.com";
const tokenEndpoint = "https://github.com/login/oauth/access_token";
const apiHeaders = { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "ARGUS-Discord-Agent" };

type TokenResponse = {
  access_token?: string;
  expires_in?: number;
  refresh_token?: string;
  refresh_token_expires_in?: number;
  error?: string;
  error_description?: string;
};

type GithubUser = { id: number; login: string };
type GithubInstallation = { id: number; account?: { login?: string }; repository_selection?: string; permissions?: { contents?: string; pull_requests?: string } };
type GithubRepository = { id: number; full_name: string; private: boolean; html_url: string; default_branch: string };
type GithubPullFile = { filename?: string; status?: string; additions?: number; deletions?: number; patch?: string };
type GithubCheckRun = { name?: string; status?: string; conclusion?: string | null; details_url?: string };
type GithubTreeEntry = { path?: string; mode?: string; type?: "blob" | "tree" | "commit"; sha?: string; size?: number };

export type GithubRepo = GithubRepository & { installationId: number; account: string; selection: string; contentsPermission: string; pullRequestsPermission: string };
export type GithubPullReviewContext = {
  repo: string;
  number: number;
  title: string;
  body: string;
  url: string;
  headSha: string;
  files: GithubPullFile[];
  checks: GithubCheckRun[];
  checksError?: string;
};
export type GithubRepositorySnapshot = {
  repo: string;
  ref: string;
  files: Array<{ path: string; content: Uint8Array }>;
  totalBytes: number;
  skippedSensitiveFiles: number;
};
type PendingGithubChange = { repo: string; changes: GithubFileChange[]; requestedAt: string; emptyRepository: boolean };
class GithubApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

export function githubIsConfigured(): boolean {
  return config.githubConfigured;
}

export function githubInstallUrl(): string | null {
  return config.GITHUB_APP_SLUG ? `https://github.com/apps/${encodeURIComponent(config.GITHUB_APP_SLUG)}/installations/new` : null;
}

export async function createGithubConnectUrl(store: Store, discordUserId: string): Promise<string> {
  ensureConfigured();
  const state = randomBytes(32).toString("base64url");
  await store.createGithubOauthState(hashState(state), discordUserId, new Date(Date.now() + 10 * 60_000));
  const url = new URL("https://github.com/login/oauth/authorize");
  url.searchParams.set("client_id", config.GITHUB_CLIENT_ID!);
  url.searchParams.set("state", state);
  url.searchParams.set("redirect_uri", callbackUrl());
  return url.toString();
}

export async function completeGithubConnection(store: Store, code: string, state: string): Promise<{ login: string }> {
  ensureConfigured();
  const discordUserId = await store.consumeGithubOauthState(hashState(state));
  if (!discordUserId) throw new Error("Ссылка подключения устарела или уже была использована.");

  const tokens = await requestTokens({
    client_id: config.GITHUB_CLIENT_ID!,
    client_secret: config.GITHUB_CLIENT_SECRET!,
    code,
    redirect_uri: callbackUrl()
  });
  if (!tokens.access_token) throw new Error(tokens.error_description || tokens.error || "GitHub не вернул токен доступа.");
  const user = await githubRequest<GithubUser>("/user", tokens.access_token);
  const now = Date.now();
  await store.saveGithubConnection({
    discordUserId,
    githubUserId: String(user.id),
    githubLogin: user.login,
    accessTokenEncrypted: encryptToken(tokens.access_token),
    refreshTokenEncrypted: tokens.refresh_token ? encryptToken(tokens.refresh_token) : null,
    accessTokenExpiresAt: tokens.expires_in ? new Date(now + tokens.expires_in * 1000) : null,
    refreshTokenExpiresAt: tokens.refresh_token_expires_in ? new Date(now + tokens.refresh_token_expires_in * 1000) : null
  });
  return { login: user.login };
}

export async function githubConnectionStatus(store: Store, discordUserId: string): Promise<GithubConnection | null> {
  return store.getGithubConnection(discordUserId);
}

export async function listGithubRepositories(store: Store, discordUserId: string): Promise<GithubRepo[]> {
  const connection = await requireConnection(store, discordUserId);
  const token = await validAccessToken(store, connection);
  const installations = await githubRequest<{ installations?: GithubInstallation[] }>("/user/installations?per_page=100", token);
  const repositories: GithubRepo[] = [];
  for (const installation of installations.installations ?? []) {
    const page = await githubRequest<{ repositories?: GithubRepository[] }>(`/user/installations/${installation.id}/repositories?per_page=100`, token);
    for (const repository of page.repositories ?? []) {
      repositories.push({
        ...repository,
        installationId: installation.id,
        account: installation.account?.login || "unknown",
        selection: installation.repository_selection || "selected",
        contentsPermission: installation.permissions?.contents || "none",
        pullRequestsPermission: installation.permissions?.pull_requests || "none"
      });
    }
  }
  return repositories.sort((a, b) => a.full_name.localeCompare(b.full_name));
}

export function selectedGithubRepository(store: Store, discordUserId: string): string | null {
  return store.getSetting(`github_repo:${discordUserId}`) || null;
}

export async function selectGithubRepository(store: Store, discordUserId: string, fullName: string): Promise<void> {
  const repositories = await listGithubRepositories(store, discordUserId);
  if (!repositories.some((repository) => repository.full_name === fullName)) throw new Error("Этот репозиторий не разрешён установленному GitHub App.");
  await store.setSetting(`github_repo:${discordUserId}`, fullName);
}

export async function prepareGithubFileChanges(
  store: Store,
  discordUserId: string,
  changes: GithubFileChange[]
): Promise<{ id: string; repo: string; expiresAt: Date; emptyRepository: boolean }> {
  if (!changes.length) throw new Error("Нет изменений для GitHub.");
  const repo = selectedGithubRepository(store, discordUserId);
  if (!repo) throw new Error("Сначала выбери репозиторий через `!github` → «Репозитории».");
  const repositories = await listGithubRepositories(store, discordUserId);
  const repository = repositories.find((item) => item.full_name === repo);
  if (!repository) {
    await store.deleteSetting(`github_repo:${discordUserId}`);
    throw new Error("Ранее выбранный репозиторий больше недоступен. Выбери его заново.");
  }
  if (repository.contentsPermission !== "write") {
    throw new Error("GitHub App установлена без подтверждённого права Contents: Read and write. Подтверди новые права в GitHub Installed Apps, затем переподключи аккаунт через `!github` → «Подключить».");
  }
  if (new Set(changes.map((change) => change.path)).size !== changes.length) throw new Error("Один файл нельзя изменять несколько раз в одном пакете.");
  const totalBytes = changes.reduce((sum, change) => sum + Buffer.byteLength(change.content || "", "utf8"), 0);
  if (totalBytes > 5_000_000) throw new Error("Общий размер пакета изменений превышает 5 МБ.");
  const connection = await requireConnection(store, discordUserId);
  const token = await validAccessToken(store, connection);
  const [owner, repoName] = repo.split("/");
  if (!owner || !repoName) throw new Error("Некорректное имя репозитория.");
  const root = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repoName)}`;
  const emptyRepository = !(await githubDefaultBranchSha(root, repository.default_branch, token));
  if (emptyRepository && changes.some((change) => change.action === "delete")) throw new Error("В пустом репозитории пока нечего удалять.");
  if (!emptyRepository && repository.pullRequestsPermission !== "write") {
    throw new Error("Для автоматического Pull Request требуется GitHub App permission Pull requests: Read and write. Подтверди новые права в Installed GitHub Apps и переподключи аккаунт.");
  }
  const id = randomBytes(12).toString("base64url");
  const expiresAt = new Date(Date.now() + 15 * 60_000);
  const payload: PendingGithubChange = { repo, changes: changes.slice(0, 10), requestedAt: new Date().toISOString(), emptyRepository };
  await store.saveGithubPendingChange(id, discordUserId, encryptToken(JSON.stringify(payload)), expiresAt);
  return { id, repo, expiresAt, emptyRepository };
}

export async function previewGithubFileChanges(store: Store, discordUserId: string, id: string): Promise<PendingGithubChange> {
  const encrypted = await store.getGithubPendingChange(id, discordUserId);
  if (!encrypted) throw new Error("Пакет изменений не найден, уже обработан или просрочен.");
  return JSON.parse(decryptToken(encrypted)) as PendingGithubChange;
}

export async function readSelectedGithubFiles(
  store: Store,
  discordUserId: string,
  paths: string[]
): Promise<Array<{ path: string; content: string }>> {
  const repoName = selectedGithubRepository(store, discordUserId);
  if (!repoName) throw new Error("Рабочий репозиторий не выбран.");
  const repositories = await listGithubRepositories(store, discordUserId);
  const repository = repositories.find((item) => item.full_name === repoName);
  if (!repository) throw new Error("Выбранный репозиторий больше недоступен.");
  const connection = await requireConnection(store, discordUserId);
  const token = await validAccessToken(store, connection);
  const [owner, repo] = repoName.split("/");
  if (!owner || !repo) throw new Error("Некорректное имя репозитория.");
  const root = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
  const result: Array<{ path: string; content: string }> = [];
  let totalBytes = 0;
  for (const path of paths.slice(0, 5)) {
    let data: { type?: string; size?: number; encoding?: string; content?: string; message?: string };
    try {
      data = await githubRequest(`${root}/contents/${encodeRepositoryPath(path)}?ref=${encodeURIComponent(repository.default_branch)}`, token);
    } catch (error) {
      if (error instanceof GithubApiError && (error.status === 404 || error.status === 409)) {
        result.push({ path, content: "[Файл отсутствует. Репозиторий может быть пустым; создай файл с новым содержимым.]" });
        continue;
      }
      throw error;
    }
    if (data.type !== "file" || data.encoding !== "base64" || typeof data.content !== "string") throw new Error(`${path} не является доступным текстовым файлом.`);
    const buffer = Buffer.from(data.content.replace(/\s/g, ""), "base64");
    totalBytes += buffer.length;
    if (buffer.length > 200_000 || totalBytes > 500_000) throw new Error("Файлы слишком большие для контекста агента.");
    if (buffer.includes(0)) throw new Error(`${path} похож на бинарный файл.`);
    result.push({ path, content: buffer.toString("utf8") });
  }
  return result;
}

export async function cancelGithubFileChanges(store: Store, discordUserId: string, id: string) {
  await store.deleteGithubPendingChange(id, discordUserId);
}

export async function applyGithubFileChanges(
  store: Store,
  discordUserId: string,
  id: string
): Promise<{ repo: string; branch: string; url: string; changed: number; initializedDefault: boolean; pullRequest?: { number: number; url: string; title: string }; pullRequestError?: string }> {
  const encrypted = await store.consumeGithubPendingChange(id, discordUserId);
  if (!encrypted) throw new Error("Пакет изменений не найден, уже обработан или просрочен.");
  const pending = JSON.parse(decryptToken(encrypted)) as PendingGithubChange;
  const repositories = await listGithubRepositories(store, discordUserId);
  const repository = repositories.find((item) => item.full_name === pending.repo);
  if (!repository) throw new Error("Доступ к выбранному репозиторию отозван.");
  const connection = await requireConnection(store, discordUserId);
  const token = await validAccessToken(store, connection);
  const [owner, repo] = pending.repo.split("/");
  if (!owner || !repo) throw new Error("Некорректное имя репозитория.");
  const root = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
  const defaultBranch = repository.default_branch;
  const fileStates = new Map<string, { sha: string } | null>();
  for (const change of pending.changes) {
    const existing = await githubContentState(root, change.path, defaultBranch, token);
    if (change.action === "delete" && !existing) throw new Error(`Нельзя удалить отсутствующий файл: ${change.path}`);
    fileStates.set(change.path, existing);
  }

  const baseSha = await githubDefaultBranchSha(root, defaultBranch, token);
  if (!baseSha) {
    if (pending.changes.some((change) => change.action !== "write")) throw new Error("Пустой репозиторий можно только инициализировать новыми файлами.");
    for (const [index, change] of pending.changes.entries()) {
      await githubApiRequest(`${root}/contents/${encodeRepositoryPath(change.path)}`, token, {
        method: "PUT",
        body: JSON.stringify({
          message: `${index === 0 ? "Initialize repository with" : "Create"} ${change.path} via ARGUS`,
          content: Buffer.from(change.content || "", "utf8").toString("base64"),
          ...(index === 0 ? {} : { branch: defaultBranch })
        })
      });
    }
    return {
      repo: pending.repo,
      branch: defaultBranch,
      url: `https://github.com/${pending.repo}/tree/${encodeURIComponent(defaultBranch)}`,
      changed: pending.changes.length,
      initializedDefault: true
    };
  }
  const branch = `argus/${new Date().toISOString().slice(0, 10)}-${id.slice(0, 6).toLowerCase()}`;
  await githubApiRequest(`${root}/git/refs`, token, {
    method: "POST",
    body: JSON.stringify({ ref: `refs/heads/${branch}`, sha: baseSha })
  });

  for (const change of pending.changes) {
    const endpoint = `${root}/contents/${encodeRepositoryPath(change.path)}`;
    const existing = fileStates.get(change.path);
    if (change.action === "write") {
      await githubApiRequest(endpoint, token, {
        method: "PUT",
        body: JSON.stringify({
          message: `${existing ? "Update" : "Create"} ${change.path} via ARGUS`,
          content: Buffer.from(change.content || "", "utf8").toString("base64"),
          branch,
          ...(existing ? { sha: existing.sha } : {})
        })
      });
    } else {
      await githubApiRequest(endpoint, token, {
        method: "DELETE",
        body: JSON.stringify({ message: `Delete ${change.path} via ARGUS`, sha: existing!.sha, branch })
      });
    }
  }
  const pullTitle = githubPullRequestTitle(pending.changes);
  const pullBody = [
    "## Изменения",
    "",
    ...pending.changes.map((change) => `- ${change.action === "delete" ? "Удалить" : "Создать или обновить"} \`${change.path}\``),
    "",
    "Пакет подготовлен агентом ARGUS и применён после подтверждения пользователя в Discord.",
    "",
    `Исходная ветка: \`${branch}\``,
    `Базовая ветка: \`${defaultBranch}\``
  ].join("\n");
  let pullRequest: { number: number; url: string; title: string } | undefined;
  let pullRequestError: string | undefined;
  try {
    const pull = await githubApiRequest<{ number?: number; html_url?: string; title?: string }>(`${root}/pulls`, token, {
      method: "POST",
      body: JSON.stringify({ title: pullTitle, body: pullBody, head: branch, base: defaultBranch, draft: true })
    });
    if (!pull.number || !pull.html_url) throw new Error("GitHub не вернул данные Pull Request.");
    pullRequest = { number: pull.number, url: pull.html_url, title: pull.title || pullTitle };
  } catch (error) {
    console.error("GitHub branch was updated but Pull Request creation failed", error);
    pullRequestError = error instanceof Error ? error.message : String(error);
  }
  return {
    repo: pending.repo,
    branch,
    url: `https://github.com/${pending.repo}/tree/${encodeURIComponent(branch)}`,
    changed: pending.changes.length,
    initializedDefault: false,
    ...(pullRequest ? { pullRequest } : {}),
    ...(pullRequestError ? { pullRequestError } : {})
  };
}

export async function readGithubPullRequestContext(
  store: Store,
  discordUserId: string,
  repoName: string,
  pullNumber: number
): Promise<GithubPullReviewContext> {
  if (selectedGithubRepository(store, discordUserId) !== repoName) throw new Error("Этот репозиторий больше не выбран как рабочий.");
  const repositories = await listGithubRepositories(store, discordUserId);
  if (!repositories.some((item) => item.full_name === repoName)) throw new Error("Репозиторий больше недоступен GitHub App.");
  const connection = await requireConnection(store, discordUserId);
  const token = await validAccessToken(store, connection);
  const [owner, repo] = repoName.split("/");
  if (!owner || !repo || !Number.isInteger(pullNumber) || pullNumber < 1) throw new Error("Некорректный Pull Request.");
  const root = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
  const [pull, files] = await Promise.all([
    githubRequest<{ number?: number; title?: string; body?: string | null; html_url?: string; head?: { sha?: string } }>(`${root}/pulls/${pullNumber}`, token),
    githubRequest<GithubPullFile[]>(`${root}/pulls/${pullNumber}/files?per_page=100`, token)
  ]);
  if (!pull.number || !pull.html_url || !pull.head?.sha) throw new Error("GitHub вернул неполные данные Pull Request.");
  let checks: GithubCheckRun[] = [];
  let checksError: string | undefined;
  try {
    const response = await githubRequest<{ check_runs?: GithubCheckRun[] }>(`${root}/commits/${pull.head.sha}/check-runs?per_page=100`, token);
    checks = response.check_runs ?? [];
  } catch (error) {
    checksError = error instanceof Error ? error.message : String(error);
  }
  return {
    repo: repoName,
    number: pull.number,
    title: pull.title || `Pull Request #${pull.number}`,
    body: pull.body || "",
    url: pull.html_url,
    headSha: pull.head.sha,
    files: files.slice(0, 100),
    checks,
    ...(checksError ? { checksError } : {})
  };
}

export function formatGithubChecks(context: GithubPullReviewContext): string {
  if (context.checksError) return `⚠️ GitHub Checks недоступны: ${context.checksError}`;
  if (!context.checks.length) return "⏳ GitHub Checks пока не появились или workflow в репозитории не настроен.";
  return context.checks.map((check) => {
    const result = check.conclusion || check.status || "unknown";
    const icon = result === "success" ? "✅" : ["failure", "cancelled", "timed_out", "action_required"].includes(result) ? "❌" : "⏳";
    return `${icon} **${check.name || "Проверка"}** — \`${result}\`${check.details_url ? ` · [открыть](<${check.details_url}>)` : ""}`;
  }).join("\n");
}

export async function readGithubRepositorySnapshot(
  store: Store,
  discordUserId: string,
  repoName: string,
  ref?: string
): Promise<GithubRepositorySnapshot> {
  if (selectedGithubRepository(store, discordUserId) !== repoName) throw new Error("Этот репозиторий больше не выбран как рабочий.");
  const repositories = await listGithubRepositories(store, discordUserId);
  const repository = repositories.find((item) => item.full_name === repoName);
  if (!repository) throw new Error("Репозиторий больше недоступен GitHub App.");
  const connection = await requireConnection(store, discordUserId);
  const token = await validAccessToken(store, connection);
  const [owner, repo] = repoName.split("/");
  if (!owner || !repo) throw new Error("Некорректное имя репозитория.");
  const root = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
  const requestedRef = ref || repository.default_branch;
  const tree = await githubRequest<{ tree?: GithubTreeEntry[]; truncated?: boolean }>(
    `${root}/git/trees/${encodeURIComponent(requestedRef)}?recursive=1`,
    token
  );
  if (tree.truncated) throw new Error("Дерево репозитория слишком велико для безопасной загрузки в песочницу.");
  const allBlobs = (tree.tree ?? []).filter((entry) => entry.type === "blob" && entry.sha && entry.path);
  const blobs = allBlobs.filter((entry) => !isSensitiveSnapshotPath(entry.path!));
  if (!blobs.length) throw new Error("В выбранной ветке нет файлов.");
  if (blobs.length > 750) throw new Error(`В репозитории ${blobs.length} файлов — лимит песочницы 750.`);
  const declaredBytes = blobs.reduce((sum, entry) => sum + (entry.size || 0), 0);
  if (declaredBytes > 20_000_000) throw new Error("Размер репозитория превышает лимит песочницы 20 МБ.");

  const files: GithubRepositorySnapshot["files"] = [];
  let totalBytes = 0;
  for (let offset = 0; offset < blobs.length; offset += 10) {
    const batch = blobs.slice(offset, offset + 10);
    const loaded = await Promise.all(batch.map(async (entry) => {
      const path = safeSnapshotPath(entry.path!);
      const blob = await githubRequest<{ encoding?: string; content?: string; size?: number }>(`${root}/git/blobs/${entry.sha}`, token);
      if (blob.encoding !== "base64" || typeof blob.content !== "string") throw new Error(`GitHub не вернул содержимое ${path}.`);
      const content = Buffer.from(blob.content.replace(/\s/g, ""), "base64");
      if (content.length > 5_000_000) throw new Error(`Файл ${path} превышает лимит 5 МБ.`);
      return { path, content };
    }));
    for (const file of loaded) {
      totalBytes += file.content.length;
      if (totalBytes > 20_000_000) throw new Error("Размер репозитория превышает лимит песочницы 20 МБ.");
      files.push(file);
    }
  }
  return { repo: repoName, ref: requestedRef, files, totalBytes, skippedSensitiveFiles: allBlobs.length - blobs.length };
}

export async function disconnectGithub(store: Store, discordUserId: string): Promise<{ login: string; revoked: boolean }> {
  ensureConfigured();
  const connection = await requireConnection(store, discordUserId);
  let revoked = false;
  try {
    const accessToken = decryptToken(connection.accessTokenEncrypted);
    const basic = Buffer.from(`${config.GITHUB_CLIENT_ID}:${config.GITHUB_CLIENT_SECRET}`).toString("base64");
    const response = await fetch(`${githubApi}/applications/${encodeURIComponent(config.GITHUB_CLIENT_ID!)}/grant`, {
      method: "DELETE",
      headers: { ...apiHeaders, Authorization: `Basic ${basic}`, "Content-Type": "application/json" },
      body: JSON.stringify({ access_token: accessToken }),
      signal: AbortSignal.timeout(15_000)
    });
    revoked = response.status === 204 || response.status === 404;
  } catch (error) {
    console.error("Failed to revoke GitHub grant", error);
  } finally {
    await store.deleteGithubConnection(discordUserId);
  }
  return { login: connection.githubLogin, revoked };
}

async function validAccessToken(store: Store, connection: GithubConnection): Promise<string> {
  if (!connection.accessTokenExpiresAt || connection.accessTokenExpiresAt.getTime() > Date.now() + 60_000) {
    return decryptToken(connection.accessTokenEncrypted);
  }
  if (!connection.refreshTokenEncrypted || (connection.refreshTokenExpiresAt && connection.refreshTokenExpiresAt.getTime() <= Date.now())) {
    throw new Error("Срок подключения GitHub истёк. Выполни `!github connect` снова.");
  }
  const tokens = await requestTokens({
    client_id: config.GITHUB_CLIENT_ID!,
    client_secret: config.GITHUB_CLIENT_SECRET!,
    grant_type: "refresh_token",
    refresh_token: decryptToken(connection.refreshTokenEncrypted)
  });
  if (!tokens.access_token) throw new Error(tokens.error_description || tokens.error || "Не удалось обновить токен GitHub.");
  const now = Date.now();
  const refreshed = {
    discordUserId: connection.discordUserId,
    githubUserId: connection.githubUserId,
    githubLogin: connection.githubLogin,
    accessTokenEncrypted: encryptToken(tokens.access_token),
    refreshTokenEncrypted: tokens.refresh_token ? encryptToken(tokens.refresh_token) : connection.refreshTokenEncrypted,
    accessTokenExpiresAt: tokens.expires_in ? new Date(now + tokens.expires_in * 1000) : null,
    refreshTokenExpiresAt: tokens.refresh_token_expires_in ? new Date(now + tokens.refresh_token_expires_in * 1000) : connection.refreshTokenExpiresAt
  };
  await store.saveGithubConnection(refreshed);
  return tokens.access_token;
}

async function requireConnection(store: Store, discordUserId: string): Promise<GithubConnection> {
  ensureConfigured();
  const connection = await store.getGithubConnection(discordUserId);
  if (!connection) throw new Error("GitHub не подключён. Используй `!github connect`.");
  return connection;
}

async function requestTokens(parameters: Record<string, string>): Promise<TokenResponse> {
  const response = await fetch(tokenEndpoint, {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(parameters),
    signal: AbortSignal.timeout(15_000)
  });
  const data = await response.json().catch(() => ({})) as TokenResponse;
  if (!response.ok) throw new Error(data.error_description || data.error || `GitHub OAuth вернул ${response.status}`);
  return data;
}

async function githubRequest<T>(path: string, token: string): Promise<T> {
  return githubApiRequest<T>(path, token);
}

async function githubApiRequest<T = unknown>(path: string, token: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${githubApi}${path}`, {
    ...init,
    headers: { ...apiHeaders, Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...init.headers },
    signal: AbortSignal.timeout(15_000)
  });
  const data = await response.json().catch(() => ({})) as T & { message?: string };
  if (!response.ok) {
    const acceptedPermissions = response.headers.get("x-accepted-github-permissions") || "";
    if (response.status === 403 && /resource not accessible by integration/iu.test(data.message || "")) {
      if (/checks=read/iu.test(acceptedPermissions)) {
        throw new GithubApiError("GitHub App не хватает права Checks: Read-only. Добавь его в настройках приложения и подтверди обновлённые права установки.", response.status);
      }
      throw new GithubApiError(
        `GitHub запретил запись приложению. Проверь Contents: Read and write, подтверди обновлённые права установленной GitHub App и заново выполни подключение.${acceptedPermissions ? ` Требуемые права: ${acceptedPermissions}.` : ""}`,
        response.status
      );
    }
    throw new GithubApiError(data.message || `GitHub API вернул ${response.status}`, response.status);
  }
  return data;
}

async function githubContentState(root: string, path: string, ref: string, token: string): Promise<{ sha: string } | null> {
  const response = await fetch(`${githubApi}${root}/contents/${encodeRepositoryPath(path)}?ref=${encodeURIComponent(ref)}`, {
    headers: { ...apiHeaders, Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(15_000)
  });
  if (response.status === 404 || response.status === 409) return null;
  const data = await response.json().catch(() => ({})) as { sha?: string; type?: string; message?: string };
  if (!response.ok) throw new Error(data.message || `GitHub API вернул ${response.status}`);
  if (data.type !== "file" || !data.sha) throw new Error(`${path} не является обычным файлом.`);
  return { sha: data.sha };
}

async function githubDefaultBranchSha(root: string, defaultBranch: string, token: string): Promise<string | null> {
  try {
    const reference = await githubRequest<{ object?: { sha?: string } }>(`${root}/git/ref/heads/${encodeURIComponent(defaultBranch)}`, token);
    return reference.object?.sha || null;
  } catch (error) {
    if (error instanceof GithubApiError && (error.status === 404 || error.status === 409)) return null;
    throw error;
  }
}

function encodeRepositoryPath(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}

function safeSnapshotPath(value: string): string {
  const normalized = value.replace(/\\/g, "/").replace(/^\.\//, "");
  if (!normalized || normalized.startsWith("/") || normalized.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new Error("GitHub вернул небезопасный путь файла.");
  }
  return normalized;
}

function isSensitiveSnapshotPath(value: string): boolean {
  const path = value.replace(/\\/g, "/").toLowerCase();
  const name = path.split("/").at(-1) || "";
  return name === ".env" || /^\.env\.(?!example$|sample$)/.test(name) ||
    [".npmrc", ".pypirc", ".git-credentials", "id_rsa", "id_ed25519"].includes(name) ||
    name.endsWith(".pem") || name.endsWith(".key") || name.endsWith(".p12") || name.endsWith(".pfx");
}

function githubPullRequestTitle(changes: GithubFileChange[]): string {
  if (changes.length === 1) {
    const change = changes[0]!;
    return `ARGUS: ${change.action === "delete" ? "Delete" : "Update"} ${change.path}`.slice(0, 200);
  }
  return `ARGUS: Update ${changes.length} files`;
}

function callbackUrl(): string {
  const base = config.GITHUB_CALLBACK_URL || (process.env.RENDER_EXTERNAL_URL ? `${process.env.RENDER_EXTERNAL_URL}/auth/github/callback` : "");
  if (!base) throw new Error("Не задан GITHUB_CALLBACK_URL.");
  return base;
}

function ensureConfigured() {
  if (!config.githubConfigured) throw new Error("Интеграция GitHub ещё не настроена на Render.");
  encryptionKey();
  callbackUrl();
}

function encryptionKey(): Buffer {
  return decodeEncryptionKey(config.GITHUB_TOKEN_ENCRYPTION_KEY || "");
}

function encryptToken(value: string): string {
  encryptionKey();
  return encryptSecret(value, config.GITHUB_TOKEN_ENCRYPTION_KEY!);
}

function decryptToken(value: string): string {
  encryptionKey();
  return decryptSecret(value, config.GITHUB_TOKEN_ENCRYPTION_KEY!);
}

function hashState(state: string): string {
  return createHash("sha256").update(state).digest("hex");
}
