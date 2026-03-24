import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  pi.registerCommand({
    name: "video-cut",
    description: "Create a rough cut or editorial cut from a video recording",
    execute: async (args, ctx) => {
      const videoPath = args?.trim();
      const msg = videoPath
        ? `Use the video-cut skill on this video: ${videoPath}\nSave all outputs to the current directory.`
        : `Use the video-cut skill. Ask me for the video file path and any details.`;
      ctx.agent.queueMessage(msg);
    },
  });
}
