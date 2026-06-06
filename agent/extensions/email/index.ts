import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const TOKEN_KEYCHAIN_SERVICE = "pi-email-gmail";
const CONFIG_KEYCHAIN_SERVICE = "pi-email-gmail-config";
const KEYCHAIN_ACCOUNT = "default";
const REDIRECT_PORT = 53682;
const REDIRECT_URI = `http://127.0.0.1:${REDIRECT_PORT}/oauth2/callback`;
const GMAIL_READONLY_SCOPE = "https://www.googleapis.com/auth/gmail.readonly";

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

async function readKeychainJson<T>(service: string): Promise<T | null> {
  try {
    const { stdout } = await execFileAsync("security", [
      "find-generic-password",
      "-s",
      service,
      "-a",
      KEYCHAIN_ACCOUNT,
      "-w",
    ]);
    return JSON.parse(stdout.trim()) as T;
  } catch {
    return null;
  }
}

async function writeKeychainJson(service: string, value: unknown) {
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
}

async function deleteKeychainItem(service: string) {
  try {
    await execFileAsync("security", ["delete-generic-password", "-s", service, "-a", KEYCHAIN_ACCOUNT]);
  } catch {
    // Already absent.
  }
}

async function getGoogleClientConfig(): Promise<GoogleClientConfig> {
  const keychainConfig = await readKeychainJson<GoogleClientConfig>(CONFIG_KEYCHAIN_SERVICE);
  const clientId = keychainConfig?.clientId ?? process.env.PI_EMAIL_GOOGLE_CLIENT_ID ?? process.env.GOOGLE_CLIENT_ID;
  const clientSecret =
    keychainConfig?.clientSecret ?? process.env.PI_EMAIL_GOOGLE_CLIENT_SECRET ?? process.env.GOOGLE_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    throw new Error("Run /email config to store Google OAuth client credentials in macOS Keychain.");
  }

  return { clientId, clientSecret };
}

async function readToken(): Promise<GmailToken | null> {
  return readKeychainJson<GmailToken>(TOKEN_KEYCHAIN_SERVICE);
}

async function writeToken(token: GmailToken) {
  await writeKeychainJson(TOKEN_KEYCHAIN_SERVICE, token);
}

async function deleteToken() {
  await deleteKeychainItem(TOKEN_KEYCHAIN_SERVICE);
}

async function exchangeCodeForToken(code: string): Promise<GmailToken> {
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
  });

  if (!response.ok) throw new Error(`Token exchange failed: ${response.status} ${await response.text()}`);

  const token = (await response.json()) as GmailToken;
  return { ...token, expires_at: Date.now() + (token.expires_in ?? 0) * 1000 };
}

async function startOAuthFlow(): Promise<GmailToken> {
  const { clientId } = await getGoogleClientConfig();
  const state = crypto.randomUUID();

  const authUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  authUrl.searchParams.set("client_id", clientId);
  authUrl.searchParams.set("redirect_uri", REDIRECT_URI);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("scope", GMAIL_READONLY_SCOPE);
  authUrl.searchParams.set("access_type", "offline");
  authUrl.searchParams.set("prompt", "consent");
  authUrl.searchParams.set("state", state);

  return await new Promise<GmailToken>((resolve, reject) => {
    const server = createServer(async (req, res) => {
      try {
        const url = new URL(req.url ?? "/", REDIRECT_URI);
        if (url.pathname !== "/oauth2/callback") return;

        if (url.searchParams.get("state") !== state) throw new Error("OAuth state mismatch.");
        const code = url.searchParams.get("code");
        if (!code) throw new Error(url.searchParams.get("error") ?? "Missing OAuth code.");

        res.writeHead(200, { "content-type": "text/plain" });
        res.end("pi email auth complete. You can close this tab.\n");
        server.close();
        resolve(await exchangeCodeForToken(code));
      } catch (error) {
        res.writeHead(500, { "content-type": "text/plain" });
        res.end(String(error));
        server.close();
        reject(error);
      }
    });

    server.once("error", reject);
    server.listen(REDIRECT_PORT, "127.0.0.1", async () => {
      await execFileAsync("open", [authUrl.toString()]);
    });
  });
}

export default function (pi: ExtensionAPI) {
  pi.registerCommand("email", {
    description: "Email assistant commands",
    handler: async (args, ctx) => {
      const subcommand = args.trim() || "help";

      if (subcommand === "help") {
        ctx.ui.notify("/email config, /email auth, /email status, /email logout, /email clear-config", "info");
        return;
      }

      if (subcommand === "status") {
        const token = await readToken();
        const config = await readKeychainJson<GoogleClientConfig>(CONFIG_KEYCHAIN_SERVICE);
        ctx.ui.notify(
          `gmail auth: ${token?.refresh_token ? "connected" : "not connected"}; config: ${config ? "stored" : "missing"}`,
          "info",
        );
        return;
      }

      if (subcommand === "config") {
        const clientId = await ctx.ui.input("Google OAuth client ID", "paste client ID...");
        if (!clientId) {
          ctx.ui.notify("email config cancelled", "info");
          return;
        }

        const clientSecret = await ctx.ui.input("Google OAuth client secret", "paste client secret...");
        if (!clientSecret) {
          ctx.ui.notify("email config cancelled", "info");
          return;
        }

        await writeKeychainJson(CONFIG_KEYCHAIN_SERVICE, { clientId: clientId.trim(), clientSecret: clientSecret.trim() });
        ctx.ui.notify("gmail OAuth config stored in macOS Keychain", "info");
        return;
      }

      if (subcommand === "clear-config") {
        await deleteKeychainItem(CONFIG_KEYCHAIN_SERVICE);
        ctx.ui.notify("gmail OAuth config removed from Keychain", "info");
        return;
      }

      if (subcommand === "auth") {
        try {
          ctx.ui.notify("Opening Google OAuth…", "info");
          const token = await startOAuthFlow();
          await writeToken(token);
          ctx.ui.notify("gmail auth: connected. refresh token stored in macOS Keychain.", "info");
        } catch (error) {
          ctx.ui.notify(`gmail auth failed: ${error instanceof Error ? error.message : String(error)}`, "error");
        }
        return;
      }

      if (subcommand === "logout") {
        await deleteToken();
        ctx.ui.notify("gmail auth removed from Keychain", "info");
        return;
      }

      ctx.ui.notify(`unknown email command: ${subcommand}`, "warn");
    },
  });

  pi.registerTool({
    name: "email_status",
    label: "Email Status",
    description: "Report whether the Gmail email extension is authenticated",
    parameters: Type.Object({}),
    async execute() {
      const token = await readToken();
      const connected = Boolean(token?.refresh_token);
      return {
        content: [{ type: "text", text: connected ? "gmail auth: connected" : "gmail auth: not connected" }],
        details: {
          ready: connected,
          backend: "gmail",
          tokenStorage: "macOS Keychain",
          scope: GMAIL_READONLY_SCOPE,
        },
      };
    },
  });
}
