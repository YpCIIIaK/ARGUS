import { createHash, randomBytes } from "node:crypto";
import { config } from "./config.js";
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
type GithubInstallation = { id: number; account?: { login?: string }; repository_selection?: string };
type GithubRepository = { id: number; full_name: string; private: boolean; html_url: string; default_branch: string };

export type GithubRepo = GithubRepository & { installationId: number; account: string; selection: string };

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
        selection: installation.repository_selection || "selected"
      });
    }
  }
  return repositories.sort((a, b) => a.full_name.localeCompare(b.full_name));
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
  const response = await fetch(`${githubApi}${path}`, {
    headers: { ...apiHeaders, Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(15_000)
  });
  const data = await response.json().catch(() => ({})) as T & { message?: string };
  if (!response.ok) throw new Error(data.message || `GitHub API вернул ${response.status}`);
  return data;
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
