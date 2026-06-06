import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export default function (pi: ExtensionAPI) {
  pi.registerCommand("hey", {
    description: "Say hey",
    handler: async (_args, ctx) => {
      ctx.ui.notify("hey!", "info");
    },
  });

  pi.registerTool({
    name: "hey",
    label: "Hey",
    description: "Return a tiny greeting",
    parameters: Type.Object({}),
    async execute() {
      return {
        content: [{ type: "text", text: "hey!" }],
        details: {},
      };
    },
  });
}
