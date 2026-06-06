import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export default function (pi: ExtensionAPI) {
  pi.registerCommand("email", {
    description: "Email assistant commands",
    handler: async (args, ctx) => {
      const subcommand = args.trim() || "help";

      if (subcommand === "help") {
        ctx.ui.notify("email extension loaded. next: wire inbox tools.", "info");
        return;
      }

      ctx.ui.notify(`unknown email command: ${subcommand}`, "warn");
    },
  });

  pi.registerTool({
    name: "email_status",
    label: "Email Status",
    description: "Report whether the email extension is available",
    parameters: Type.Object({}),
    async execute() {
      return {
        content: [{ type: "text", text: "email extension loaded. inbox tools not wired yet." }],
        details: { ready: false },
      };
    },
  });
}
