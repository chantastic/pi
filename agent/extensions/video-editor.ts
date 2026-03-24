import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  pi.registerCommand("video-pipeline", {
    description:
      "Full video production pipeline: cut → polish. Creates project structure and manifest.",
    execute: async (args, ctx) => {
      const videoPath = args?.trim();
      const msg = videoPath
        ? `Use the video-pipeline skill on this video: ${videoPath}`
        : `Use the video-pipeline skill. Ask me for the video file path and any details.`;
      ctx.agent.queueMessage(msg);
    },
  });

  pi.registerCommand("video-cut", {
    description: "Create a rough cut or editorial cut from a video recording",
    execute: async (args, ctx) => {
      const videoPath = args?.trim();
      const msg = videoPath
        ? `Use the video-cut skill on this video: ${videoPath}\nSave all outputs to the cut/ directory.`
        : `Use the video-cut skill. Ask me for the video file path and any details.`;
      ctx.agent.queueMessage(msg);
    },
  });

  pi.registerCommand("video-polish", {
    description:
      "Refine an existing video edit by re-transcribing and evaluating as a viewer",
    execute: async (args, ctx) => {
      ctx.agent.queueMessage(
        `Use the video-polish skill. Read manifest.json for inputs and the cut stage outputs.`
      );
    },
  });
}
