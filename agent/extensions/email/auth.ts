import { execFile } from "node:child_process";
import { createServer, type ServerResponse } from "node:http";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const TOKEN_KEYCHAIN_SERVICE = "pi-email-gmail";
const CONFIG_KEYCHAIN_SERVICE = "pi-email-gmail-config";
const KEYCHAIN_ACCOUNT = "default";
const REDIRECT_PORT = 53682;
const REDIRECT_URI = `http://127.0.0.1:${REDIRECT_PORT}/oauth2/callback`;
const OAUTH_FLOW_TIMEOUT_MS = 5 * 60 * 1000;

export const GMAIL_SCOPES = ["https://www.googleapis.com/auth/gmail.modify"];

type GmailToken = {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  expires_at?: number;
  scope?: string;
  token_type?: string;
};

type GoogleClientConfig = {
  clientId: string;
  clientSecret: string;
};

type GoogleClientConfigSource = "keychain" | "environment" | "keychain + environment" | "missing";

export type EmailStatus = {
  ready: boolean;
  configSource: GoogleClientConfigSource | "unavailable";
  tokenStored: boolean;
  grantedScopes: string[];
  missingScopes: string[];
  account?: string;
  issue?: string;
};

export function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function isMissingKeychainItem(error: unknown) {
  if (!error || typeof error !== "object") return false;
  const failure = error as { code?: unknown; stderr?: unknown };
  return failure.code === 44 || String(failure.stderr ?? "").includes("could not be found in the keychain");
}

function keychainFailure(action: string, service: string, error: unknown) {
  const stderr = error && typeof error === "object" ? String((error as { stderr?: unknown }).stderr ?? "").trim() : "";
  return new Error(`Could not ${action} macOS Keychain item ${service}: ${stderr || errorMessage(error)}`, { cause: error });
}

async function readKeychainJson<T>(service: string): Promise<T | null> {
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync("security", [
      "find-generic-password",
      "-s",
      service,
      "-a",
      KEYCHAIN_ACCOUNT,
      "-w",
    ]));
  } catch (error) {
    if (isMissingKeychainItem(error)) return null;
    throw keychainFailure("read", service, error);
  }

  try {
    return JSON.parse(stdout.trim()) as T;
  } catch (error) {
    throw new Error(`macOS Keychain item ${service} contains invalid JSON. Remove and recreate it.`, { cause: error });
  }
}

async function writeKeychainJson(service: string, value: unknown) {
  try {
    await execFileAsync("security", [
      "add-generic-password",
      "-U",
      "-s",
      service,
      "-a",
      KEYCHAIN_ACCOUNT,
      "-w",
      JSON.stringify(value),
    ]);
  } catch (error) {
    throw keychainFailure("write", service, error);
  }
}

async function deleteKeychainItem(service: string) {
  try {
    await execFileAsync("security", ["delete-generic-password", "-s", service, "-a", KEYCHAIN_ACCOUNT]);
  } catch (error) {
    if (isMissingKeychainItem(error)) return;
    throw keychainFailure("delete", service, error);
  }
}

async function resolveGoogleClientConfig(): Promise<{ config: GoogleClientConfig | null; source: GoogleClientConfigSource }> {
  const keychainConfig = await readKeychainJson<GoogleClientConfig>(CONFIG_KEYCHAIN_SERVICE);
  const environmentClientId = process.env.PI_EMAIL_GOOGLE_CLIENT_ID ?? process.env.GOOGLE_CLIENT_ID;
  const environmentClientSecret = process.env.PI_EMAIL_GOOGLE_CLIENT_SECRET ?? process.env.GOOGLE_CLIENT_SECRET;
  const clientId = keychainConfig?.clientId || environmentClientId;
  const clientSecret = keychainConfig?.clientSecret || environmentClientSecret;

  if (!clientId || !clientSecret) return { config: null, source: "missing" };

  const usesKeychain = Boolean(keychainConfig?.clientId || keychainConfig?.clientSecret);
  const usesEnvironment = Boolean(
    (!keychainConfig?.clientId && environmentClientId) ||
    (!keychainConfig?.clientSecret && environmentClientSecret),
  );
  const source = usesKeychain && usesEnvironment ? "keychain + environment" : usesKeychain ? "keychain" : "environment";
  return { config: { clientId, clientSecret }, source };
}

async function getGoogleClientConfig() {
  const { config } = await resolveGoogleClientConfig();
  if (!config) throw new Error("Run /email config to store Google OAuth client credentials in macOS Keychain.");
  return config;
}

async function readToken() {
  return await readKeychainJson<GmailToken>(TOKEN_KEYCHAIN_SERVICE);
}

async function writeToken(token: GmailToken) {
  await writeKeychainJson(TOKEN_KEYCHAIN_SERVICE, token);
}

async function refreshAccessToken(token: GmailToken, clientConfig?: GoogleClientConfig) {
  if (token.access_token && token.expires_at && token.expires_at > Date.now() + 60_000) return token;
  if (!token.refresh_token) throw new Error("Missing Gmail refresh token. Run /email auth again.");

  const { clientId, clientSecret } = clientConfig ?? await getGoogleClientConfig();
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: token.refresh_token,
      grant_type: "refresh_token",
    }),
  });

  if (!response.ok) throw new Error(`Token refresh failed: ${response.status} ${await response.text()}`);

  const refreshed = (await response.json()) as GmailToken;
  const next = {
    ...token,
    ...refreshed,
    refresh_token: token.refresh_token,
    expires_at: Date.now() + (refreshed.expires_in ?? 0) * 1000,
  };
  await writeToken(next);
  return next;
}

export async function getAccessToken() {
  const token = await readToken();
  if (!token) throw new Error("Gmail is not connected. Run /email auth.");
  const refreshed = await refreshAccessToken(token);
  if (!refreshed.access_token) throw new Error("Missing Gmail access token. Run /email auth again.");
  return refreshed.access_token;
}

export async function saveGoogleClientConfig(clientId: string, clientSecret: string) {
  await writeKeychainJson(CONFIG_KEYCHAIN_SERVICE, {
    clientId: clientId.trim(),
    clientSecret: clientSecret.trim(),
  });
}

export async function clearGoogleClientConfig() {
  await deleteKeychainItem(CONFIG_KEYCHAIN_SERVICE);
}

export async function deleteToken() {
  await deleteKeychainItem(TOKEN_KEYCHAIN_SERVICE);
}

function scopesFromToken(token: GmailToken | null) {
  return Array.from(new Set(token?.scope?.split(/\s+/).filter(Boolean) ?? []));
}

async function inspectEmailStatus(checkAccount: (accessToken: string) => Promise<string>): Promise<EmailStatus> {
  const { config, source: configSource } = await resolveGoogleClientConfig();
  const token = await readToken();
  const grantedScopes = scopesFromToken(token);
  const grantedScopeSet = new Set(grantedScopes);
  const missingScopes = GMAIL_SCOPES.filter((scope) => !grantedScopeSet.has(scope));
  const status = {
    ready: false,
    configSource,
    tokenStored: Boolean(token?.refresh_token),
    grantedScopes,
    missingScopes,
  } satisfies EmailStatus;

  if (!config) return { ...status, issue: "OAuth client configuration is missing. Run /email config." };
  if (!token?.refresh_token) return { ...status, issue: "A Gmail refresh token is missing. Run /email auth." };
  if (missingScopes.length > 0) {
    return { ...status, issue: "The stored token does not report every required Gmail scope. Run /email auth." };
  }

  try {
    const refreshed = await refreshAccessToken(token, config);
    if (!refreshed.access_token) throw new Error("Google did not return an access token.");
    return { ...status, ready: true, account: await checkAccount(refreshed.access_token) };
  } catch (error) {
    return { ...status, issue: `Live Gmail check failed: ${errorMessage(error)}` };
  }
}

export async function emailStatus(checkAccount: (accessToken: string) => Promise<string>): Promise<EmailStatus> {
  try {
    return await inspectEmailStatus(checkAccount);
  } catch (error) {
    return {
      ready: false,
      configSource: "unavailable",
      tokenStored: false,
      grantedScopes: [],
      missingScopes: [...GMAIL_SCOPES],
      issue: errorMessage(error),
    };
  }
}

export function formatEmailStatus(status: EmailStatus) {
  if (status.ready) {
    return `gmail auth: connected as ${status.account}; config: ${status.configSource}; scopes: verified`;
  }
  return `gmail auth: not ready; config: ${status.configSource}; ${status.issue ?? "readiness check failed"}`;
}

async function exchangeCodeForToken(code: string, signal?: AbortSignal) {
  const { clientId, clientSecret } = await getGoogleClientConfig();
  const body = new URLSearchParams({
    code,
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: REDIRECT_URI,
    grant_type: "authorization_code",
  });

  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
    signal,
  });

  if (!response.ok) throw new Error(`Token exchange failed: ${response.status} ${await response.text()}`);

  const token = (await response.json()) as GmailToken;
  return { ...token, expires_at: Date.now() + (token.expires_in ?? 0) * 1000 };
}

export async function startOAuthFlow(): Promise<GmailToken> {
  const { clientId } = await getGoogleClientConfig();
  const state = crypto.randomUUID();

  const authUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  authUrl.searchParams.set("client_id", clientId);
  authUrl.searchParams.set("redirect_uri", REDIRECT_URI);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("scope", GMAIL_SCOPES.join(" "));
  authUrl.searchParams.set("access_type", "offline");
  authUrl.searchParams.set("prompt", "consent");
  authUrl.searchParams.set("state", state);

  return await new Promise<GmailToken>((resolve, reject) => {
    const abortController = new AbortController();
    let settled = false;
    let callbackStarted = false;
    let callbackResponse: ServerResponse | undefined;
    let server: ReturnType<typeof createServer>;
    let timeout: ReturnType<typeof setTimeout>;

    const finish = (result: { token: GmailToken } | { error: unknown }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (server.listening) server.close();
      if ("token" in result) resolve(result.token);
      else reject(result.error);
    };

    server = createServer(async (req, res) => {
      try {
        const url = new URL(req.url ?? "/", REDIRECT_URI);
        if (url.pathname !== "/oauth2/callback") {
          res.writeHead(404, { "content-type": "text/plain" });
          res.end("Not found.\n");
          return;
        }

        if (callbackStarted) {
          res.writeHead(409, { "content-type": "text/plain" });
          res.end("OAuth callback is already being processed.\n");
          return;
        }
        callbackStarted = true;
        callbackResponse = res;
        if (url.searchParams.get("state") !== state) throw new Error("OAuth state mismatch.");
        const code = url.searchParams.get("code");
        if (!code) throw new Error(url.searchParams.get("error") ?? "Missing OAuth code.");

        const token = await exchangeCodeForToken(code, abortController.signal);
        await writeToken(token);
        if (settled) return;
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("pi email auth complete. You can close this tab.\n");
        finish({ token });
      } catch (error) {
        if (settled) return;
        if (!res.writableEnded) {
          res.writeHead(500, { "content-type": "text/plain" });
          res.end(`pi email auth failed: ${errorMessage(error)}\n`);
        }
        finish({ error });
      }
    });

    timeout = setTimeout(() => {
      const error = new Error("OAuth flow timed out. Run /email auth to try again.");
      abortController.abort();
      if (callbackResponse && !callbackResponse.writableEnded) {
        callbackResponse.writeHead(504, { "content-type": "text/plain" });
        callbackResponse.end(`${error.message}\n`);
      }
      finish({ error });
    }, OAUTH_FLOW_TIMEOUT_MS);

    server.once("error", (error) => finish({ error }));
    server.listen(REDIRECT_PORT, "127.0.0.1", () => {
      execFileAsync("open", [authUrl.toString()]).catch((error) => finish({ error }));
    });
  });
}
