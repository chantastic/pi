import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import {
  clearGoogleClientConfig,
  deleteToken,
  emailStatus,
  errorMessage,
  formatEmailStatus,
  GMAIL_SCOPES,
  saveGoogleClientConfig,
  startOAuthFlow,
} from "./auth.ts";
import { getAuthenticatedEmailAddress } from "./gmail.ts";
import { runInboxSweep } from "./sweep.ts";

export default function (pi: ExtensionAPI) {
  pi.registerCommand("email", {
    description: "Triage Gmail inbox",
    handler: async (args, ctx) => {
      const subcommand = args.trim();

      if (!subcommand) {
        try {
          await runInboxSweep(ctx);
        } catch (error) {
          ctx.ui.notify(`email failed: ${errorMessage(error)}`, "error");
        } finally {
          ctx.ui.setStatus("email", undefined);
        }
        return;
      }

      try {
        if (subcommand === "help") {
          ctx.ui.notify(
            "/email starts inbox triage. Setup/admin: /email config, /email auth, /email status, /email logout, /email clear-config",
            "info",
          );
          return;
        }

        if (subcommand === "status") {
          const status = await emailStatus(getAuthenticatedEmailAddress);
          ctx.ui.notify(formatEmailStatus(status), status.ready ? "info" : "warning");
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

          await saveGoogleClientConfig(clientId, clientSecret);
          ctx.ui.notify("gmail OAuth config stored in macOS Keychain", "info");
          return;
        }

        if (subcommand === "clear-config") {
          await clearGoogleClientConfig();
          ctx.ui.notify("gmail OAuth config removed from Keychain", "info");
          return;
        }

        if (subcommand === "auth") {
          ctx.ui.notify("Opening Google OAuth…", "info");
          await startOAuthFlow();
          ctx.ui.notify("gmail auth: connected. refresh token stored in macOS Keychain.", "info");
          return;
        }

        if (subcommand === "logout") {
          await deleteToken();
          ctx.ui.notify("gmail auth removed from Keychain", "info");
          return;
        }

        ctx.ui.notify(`unknown email command: ${subcommand}`, "warning");
      } catch (error) {
        ctx.ui.notify(`email ${subcommand} failed: ${errorMessage(error)}`, "error");
      }
    },
  });

  pi.registerTool({
    name: "email_status",
    label: "Email Status",
    description: "Report whether the Gmail email extension is authenticated",
    parameters: Type.Object({}),
    async execute() {
      const status = await emailStatus(getAuthenticatedEmailAddress);
      return {
        content: [{ type: "text", text: formatEmailStatus(status) }],
        details: {
          ready: status.ready,
          backend: "gmail",
          tokenStorage: "macOS Keychain",
          configSource: status.configSource,
          tokenStored: status.tokenStored,
          scopes: {
            required: GMAIL_SCOPES,
            granted: status.grantedScopes,
            missing: status.missingScopes,
          },
          account: status.account,
          issue: status.issue,
        },
      };
    },
  });
}
