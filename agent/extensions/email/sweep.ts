import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Editor, type EditorTheme, Key, matchesKey, type OverlayOptions, truncateToWidth } from "@earendil-works/pi-tui";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import {
  archiveThreadIds,
  broadSimilarInboxQuery,
  collectInboxSweepItemAtOffset,
  collectInboxThreadIdsFromSender,
  collectNewestInboxSweepItem,
  collectSimilarInboxSelection,
  type InboxSweepItem,
  replySubject,
  sendReply,
  similarInboxQuery,
  spamThreadIds,
  trashThreadIds,
} from "./gmail.ts";

const execFileAsync = promisify(execFile);

function uniqueValues<T>(values: T[]) {
  return Array.from(new Set(values));
}

type EmailAction =
  | "archive"
  | "trash"
  | "spam"
  | "archiveSimilar"
  | "trashSimilar"
  | "replyNext"
  | "unsubscribeOpen"
  | "unsubscribeArchiveSender"
  | "skip"
  | "previous"
  | "jumpNext"
  | "jumpPrevious"
  | "escape";

const EMAIL_ACTIONS: Record<EmailAction, { label: string; keys: string[] }> = {
  archive: { label: "Archive", keys: ["Return", "e"] },
  trash: { label: "Trash", keys: ["#"] },
  spam: { label: "Spam", keys: ["!"] },
  archiveSimilar: { label: "Archive messages like this", keys: ["E"] },
  trashSimilar: { label: "Trash messages like this", keys: ["T"] },
  replyNext: { label: "Reply and next", keys: ["r"] },
  unsubscribeOpen: { label: "Open unsubscribe link", keys: ["u"] },
  unsubscribeArchiveSender: { label: "Open unsubscribe and archive sender", keys: ["U"] },
  skip: { label: "Next", keys: ["j"] },
  previous: { label: "Previous", keys: ["k"] },
  jumpNext: { label: "Jump next 10", keys: ["J"] },
  jumpPrevious: { label: "Jump previous 10", keys: ["K"] },
  escape: { label: "Escape", keys: ["q", "Esc"] },
};

const INBOX_SWEEP_ACTIONS: EmailAction[] = [
  "archive",
  "archiveSimilar",
  "trash",
  "trashSimilar",
  "spam",
  "replyNext",
  "unsubscribeOpen",
  "unsubscribeArchiveSender",
  "skip",
  "previous",
  "jumpNext",
  "jumpPrevious",
  "escape",
];

function borderLine(width: number, left: string, fill: string, right: string) {
  return left + fill.repeat(Math.max(0, width - left.length - right.length)) + right;
}

function boxedLines(title: string, bodyLines: string[], footer: string, width: number, theme: any, scrollOffset = 0) {
  const innerWidth = Math.max(20, width - 4);
  const targetHeight = Math.max(12, (process.stdout.rows ?? 24) - 4);
  const topTitle = ` ${title} `;
  const top = "┌" + topTitle + "─".repeat(Math.max(0, width - topTitle.length - 2)) + "┐";
  const bottom = borderLine(width, "└", "─", "┘");
  const separator = borderLine(width, "├", "─", "┤");
  const wrappedContent = wrapDisplayLines(bodyLines, innerWidth);
  const contentHeight = Math.max(1, targetHeight - 3);
  const maxScroll = Math.max(0, wrappedContent.length - contentHeight);
  const offset = Math.min(Math.max(0, scrollOffset), maxScroll);
  const scrollInfo = maxScroll > 0 ? ` ↑↓ ${offset + 1}-${Math.min(wrappedContent.length, offset + contentHeight)}/${wrappedContent.length}` : "";
  const visibleContent = wrappedContent.slice(offset, offset + contentHeight);
  while (visibleContent.length < contentHeight) visibleContent.push("");
  const content = visibleContent.map((line) => `│ ${truncateToWidth(line, innerWidth).padEnd(innerWidth)} │`);
  const footerLine = `│ ${truncateToWidth(`${footer}${scrollInfo}`, innerWidth).padEnd(innerWidth)} │`;
  return [theme?.fg ? theme.fg("accent", top) : top, ...content, separator, theme?.fg ? theme.fg("muted", footerLine) : footerLine, bottom];
}

function actionForKey(data: string, actions: EmailAction[]): EmailAction | undefined {
  if (matchesKey(data, Key.enter) && actions.includes("archive")) return "archive";
  if ((matchesKey(data, Key.escape) || data === "q") && actions.includes("escape")) return "escape";
  if (data === "j" && actions.includes("skip")) return "skip";
  if (data === "k" && actions.includes("previous")) return "previous";
  if (data === "J" && actions.includes("jumpNext")) return "jumpNext";
  if (data === "K" && actions.includes("jumpPrevious")) return "jumpPrevious";
  if (data === "e" && actions.includes("archive")) return "archive";
  if (data === "#" && actions.includes("trash")) return "trash";
  if (data === "!" && actions.includes("spam")) return "spam";
  if (data === "E" && actions.includes("archiveSimilar")) return "archiveSimilar";
  if (data === "T" && actions.includes("trashSimilar")) return "trashSimilar";
  if (data === "r" && actions.includes("replyNext")) return "replyNext";
  if (data === "u" && actions.includes("unsubscribeOpen")) return "unsubscribeOpen";
  if (data === "U" && actions.includes("unsubscribeArchiveSender")) return "unsubscribeArchiveSender";
  return undefined;
}

function inboxHelpLines() {
  return [
    "Message actions",
    ...INBOX_SWEEP_ACTIONS.map((action) => `${EMAIL_ACTIONS[action].keys.join(" / ")}  ${EMAIL_ACTIONS[action].label}`),
    "",
    "Reading",
    "↑ / ↓  Scroll one line",
    "PageUp / PageDown  Scroll ten lines",
    "Ctrl-U / Ctrl-D  Scroll ten lines",
  ];
}

function wrapDisplayLines(lines: string[], width: number) {
  return lines.flatMap((line) => {
    if (!line) return [""];
    const chunks: string[] = [];
    let rest = line;
    while (rest.length > width) {
      chunks.push(truncateToWidth(rest, width));
      rest = rest.slice(width);
    }
    chunks.push(truncateToWidth(rest, width));
    return chunks;
  });
}

function gmailSearchUrl(query: string) {
  return `https://mail.google.com/mail/u/0/#search/${encodeURIComponent(query)}`;
}

async function confirmBulkAction(ctx: ExtensionCommandContext, actionLabel: string, item: InboxSweepItem) {
  type BulkSelection = Awaited<ReturnType<typeof collectSimilarInboxSelection>>;
  type BulkResult = { confirmed: true; selection: BulkSelection } | { confirmed: false };
  const queries = uniqueValues([similarInboxQuery(item), broadSimilarInboxQuery(item)]);

  return await ctx.ui.custom<BulkResult>((tui: { requestRender: () => void }, theme: any, _keybindings: unknown, done: (value: BulkResult) => void) => {
    let queryIndex = 0;
    let selection: BulkSelection | null = null;
    let loading = "Loading matching threads…";
    let loadVersion = 0;

    const load = async () => {
      const version = ++loadVersion;
      const query = queries[queryIndex] ?? queries[0]!;
      loading = `Loading matches for: ${query}`;
      selection = null;
      tui.requestRender();
      try {
        const nextSelection = await collectSimilarInboxSelection(item, query, (progress) => {
          if (version !== loadVersion) return;
          loading = progress;
          tui.requestRender();
        });
        if (version !== loadVersion) return;
        selection = nextSelection;
        loading = "";
      } catch (error) {
        if (version !== loadVersion) return;
        loading = `Failed to load matches: ${error instanceof Error ? error.message : String(error)}`;
      }
      tui.requestRender();
    };

    setTimeout(() => void load(), 0);

    return {
      render(width: number) {
        const query = queries[queryIndex] ?? queries[0]!;
        return boxedLines(
          `Confirm ${actionLabel}`,
          [
            `Query: ${query}`,
            `Link: ${gmailSearchUrl(query)}`,
            `Mode: ${queryIndex === 0 ? "filtered by subject" : "expanded to sender"}`,
            "",
            selection
              ? `Threads included: ${selection.threadIds.length}. Previewing ${selection.summaries.length}:`
              : loading,
            ...(selection?.summaries.map((summary, index) => `${index + 1}. ${summary.subject || "(no subject)"}`) ?? []),
          ],
          "+ Expand  ·  - Filter  ·  Return Confirm  ·  Esc Cancel and next",
          width,
          theme,
        );
      },
      handleInput(data: string) {
        if (data === "+" && queryIndex < queries.length - 1) {
          queryIndex++;
          void load();
          return;
        }
        if (data === "-" && queryIndex > 0) {
          queryIndex--;
          void load();
          return;
        }
        if (matchesKey(data, Key.enter) && selection) done({ confirmed: true, selection });
        if (matchesKey(data, Key.escape)) done({ confirmed: false });
      },
      invalidate() {},
    };
  }, emailOverlayOptions());
}
function emailOverlayOptions(): { overlay: true; overlayOptions: OverlayOptions } {
  return {
    overlay: true,
    overlayOptions: {
      width: "100%",
      maxHeight: "100%",
      anchor: "top-left",
      row: 0,
      col: 0,
      margin: 0,
    },
  };
}

type ReplyComposeResult = { sent: true } | { sent: false };

async function composeReply(
  ctx: ExtensionCommandContext,
  item: InboxSweepItem,
  send: (body: string) => Promise<void>,
): Promise<ReplyComposeResult> {
  return await ctx.ui.custom<ReplyComposeResult>((tui: any, theme: any, _keybindings: unknown, done: (value: ReplyComposeResult) => void) => {
    const editorTheme: EditorTheme = {
      borderColor: (text) => theme?.fg ? theme.fg("accent", text) : text,
      selectList: {
        selectedPrefix: (text) => theme?.fg ? theme.fg("accent", text) : text,
        selectedText: (text) => theme?.fg ? theme.fg("accent", text) : text,
        description: (text) => theme?.fg ? theme.fg("muted", text) : text,
        scrollInfo: (text) => theme?.fg ? theme.fg("dim", text) : text,
        noMatch: (text) => theme?.fg ? theme.fg("warning", text) : text,
      },
    };
    const editor = new Editor(tui, editorTheme, { paddingX: 1 });
    editor.focused = true;
    editor.disableSubmit = true;
    let message = "";
    let sending = false;

    const submit = async () => {
      const body = editor.getExpandedText().trim();
      if (!body) {
        message = "Write a reply before sending.";
        tui.requestRender();
        return;
      }
      sending = true;
      message = "Sending reply…";
      tui.requestRender();
      try {
        await send(body);
        done({ sent: true });
      } catch (error) {
        sending = false;
        message = `Send failed: ${error instanceof Error ? error.message : String(error)}. Your draft is still here.`;
        tui.requestRender();
      }
    };

    return {
      render(width: number) {
        const innerWidth = Math.max(20, width - 4);
        const topTitle = " Reply ";
        const top = "┌" + topTitle + "─".repeat(Math.max(0, width - topTitle.length - 2)) + "┐";
        const bottom = borderLine(width, "└", "─", "┘");
        const separator = borderLine(width, "├", "─", "┤");
        const headerLines = [
          `To: ${item.replyTo || item.from || item.senderEmail}`,
          `Subject: ${replySubject(item.subject)}`,
          item.subject ? `Thread: ${item.subject}` : undefined,
          message ? "" : undefined,
          message || undefined,
        ].filter((line) => line !== undefined) as string[];
        const header = headerLines.map((line) => `│ ${truncateToWidth(line, innerWidth).padEnd(innerWidth)} │`);
        const editorLines = editor.render(innerWidth).map((line) => `│ ${truncateToWidth(line, innerWidth).padEnd(innerWidth)} │`);
        const footerText = sending ? "Sending…" : "Ctrl-S/Ctrl-X Send  ·  Esc Cancel  ·  Enter New Line";
        const footer = `│ ${truncateToWidth(footerText, innerWidth).padEnd(innerWidth)} │`;
        return [theme?.fg ? theme.fg("accent", top) : top, ...header, separator, ...editorLines, separator, theme?.fg ? theme.fg("muted", footer) : footer, bottom];
      },
      handleInput(data: string) {
        if (sending) return;
        message = "";
        if (matchesKey(data, Key.escape)) {
          done({ sent: false });
          return;
        }
        if (matchesKey(data, Key.ctrl("s")) || matchesKey(data, Key.ctrl("x"))) {
          void submit();
          return;
        }
        if (matchesKey(data, Key.enter)) {
          editor.insertTextAtCursor("\n");
          tui.requestRender();
          return;
        }
        editor.handleInput(data);
        tui.requestRender();
      },
      invalidate() {
        editor.invalidate();
      },
    };
  }, emailOverlayOptions());
}

function formatInboxSweepPrompt(item: InboxSweepItem) {
  const query = `in:inbox from:${item.senderEmail}`;
  const body = (item.bodyText || item.snippet || "No preview text.").trim();
  return [
    item.from || item.senderEmail || "unknown sender",
    `Link: ${gmailSearchUrl(query)}`,
    item.chosenUnsubscribeUrl ? `Unsubscribe: ${item.chosenUnsubscribeUrl}` : undefined,
    "",
    item.subject || "(no subject)",
    "",
    body,
  ].filter((line) => line !== undefined).join("\n");
}

export async function runInboxSweep(ctx: ExtensionCommandContext) {
  await ctx.ui.custom<void>((tui: { requestRender: () => void }, theme: any, _kb: unknown, done: () => void) => {
    const removedThreadIds = new Set<string>();
    const passedThreadIds = new Set<string>();
    const items: InboxSweepItem[] = [];
    let currentIndex = -1;
    let item: InboxSweepItem | null = null;
    let nextItemPromise: Promise<InboxSweepItem | null> | null = null;
    let considered = 0;
    let processing = false;
    let message = "Loading newest inbox email…";
    let helpVisible = false;
    let messageScrollOffset = 0;
    let helpScrollOffset = 0;

    const currentLabel = (current: InboxSweepItem) => current.senderEmail || current.from || "email";

    const excludedForNext = () => {
      const excluded = new Set(removedThreadIds);
      for (const threadId of passedThreadIds) excluded.add(threadId);
      for (const cached of items) excluded.add(cached.threadId);
      return excluded;
    };

    const prefetchNext = () => {
      nextItemPromise = collectNewestInboxSweepItem(excludedForNext()).then((prefetched) => {
        if (!prefetched) return null;
        if (removedThreadIds.has(prefetched.threadId)) return null;
        if (passedThreadIds.has(prefetched.threadId)) return null;
        if (items.some((cached) => cached.threadId === prefetched.threadId)) return null;
        return prefetched;
      }).catch((error) => {
        message = `Prefetch failed: ${error instanceof Error ? error.message : String(error)}`;
        tui.requestRender();
        return null;
      });
    };

    const setCurrentItem = (next: InboxSweepItem) => {
      item = next;
      messageScrollOffset = 0;
      message = `Triaging ${currentLabel(next)}`;
      ctx.ui.setStatus("email", `email: ${message.toLowerCase()}`);
    };

    const loadNextInboxItem = async (usePrefetch: boolean) => {
      const prefetched = usePrefetch && nextItemPromise ? await nextItemPromise : null;
      nextItemPromise = null;
      if (
        prefetched &&
        !removedThreadIds.has(prefetched.threadId) &&
        !passedThreadIds.has(prefetched.threadId) &&
        !items.some((cached) => cached.threadId === prefetched.threadId)
      ) {
        return prefetched;
      }
      return await collectNewestInboxSweepItem(excludedForNext());
    };

    const loadJumpInboxItem = async (offset: number) => {
      nextItemPromise = null;
      const result = await collectInboxSweepItemAtOffset(offset, excludedForNext());
      for (const threadId of result.skippedThreadIds) passedThreadIds.add(threadId);
      return result.item;
    };

    const showNext = async (count = 1, usePrefetch = true) => {
      processing = true;
      message = count > 1 ? `Jumping ahead ${count} inbox emails…` : "Loading next inbox email…";
      tui.requestRender();

      const futureCount = Math.max(0, items.length - currentIndex - 1);
      if (count <= futureCount) {
        currentIndex += count;
        setCurrentItem(items[currentIndex]!);
        processing = false;
        prefetchNext();
        tui.requestRender();
        return;
      }

      const remaining = count - futureCount;
      if (futureCount > 0) {
        currentIndex = items.length - 1;
        setCurrentItem(items[currentIndex]!);
      }

      const next = remaining === 1 ? await loadNextInboxItem(usePrefetch) : await loadJumpInboxItem(remaining - 1);
      processing = false;

      if (!next) {
        if (!item) {
          ctx.ui.notify(considered === 0 ? "No inbox emails found." : "inbox sweep complete", "info");
          done();
          return;
        }
        message = "No more inbox emails loaded.";
        tui.requestRender();
        return;
      }

      items.push(next);
      currentIndex = items.length - 1;
      considered++;
      setCurrentItem(next);
      prefetchNext();
      tui.requestRender();
    };

    const showPrevious = (count = 1) => {
      if (!item) return;
      if (currentIndex <= 0) {
        message = "At newest loaded email.";
        tui.requestRender();
        return;
      }
      currentIndex = Math.max(0, currentIndex - count);
      setCurrentItem(items[currentIndex]!);
      prefetchNext();
      tui.requestRender();
    };

    const removeThreadIdsFromCache = (threadIds: string[]) => {
      for (const threadId of threadIds) removedThreadIds.add(threadId);
      const removed = new Set(threadIds);
      for (let index = items.length - 1; index >= 0; index--) {
        if (!removed.has(items[index]!.threadId)) continue;
        items.splice(index, 1);
        if (index <= currentIndex) currentIndex--;
      }
      if (currentIndex >= items.length) currentIndex = items.length - 1;
      item = currentIndex >= 0 ? items[currentIndex]! : null;
    };

    const adjustScroll = (delta: number) => {
      if (helpVisible) helpScrollOffset = Math.max(0, helpScrollOffset + delta);
      else messageScrollOffset = Math.max(0, messageScrollOffset + delta);
      tui.requestRender();
    };

    const act = async (choice: EmailAction) => {
      if (processing || !item) return;
      if (choice === "escape") {
        ctx.ui.notify("inbox sweep stopped", "info");
        done();
        return;
      }
      const current = item;
      try {
        if (choice === "skip") {
          await showNext(1, true);
          return;
        }
        if (choice === "previous") {
          showPrevious(1);
          return;
        }
        if (choice === "jumpNext") {
          await showNext(10, true);
          return;
        }
        if (choice === "jumpPrevious") {
          showPrevious(10);
          return;
        }
        if (choice === "archive") {
          processing = true;
          message = `Archiving ${currentLabel(current)}…`;
          tui.requestRender();
          await archiveThreadIds([current.threadId]);
          removeThreadIdsFromCache([current.threadId]);
          await showNext(1, true);
          return;
        }
        if (choice === "trash") {
          processing = true;
          message = `Moving ${currentLabel(current)} to trash…`;
          tui.requestRender();
          await trashThreadIds([current.threadId]);
          removeThreadIdsFromCache([current.threadId]);
          await showNext(1, true);
          return;
        }
        if (choice === "spam") {
          processing = true;
          message = `Moving ${currentLabel(current)} to spam…`;
          tui.requestRender();
          await spamThreadIds([current.threadId]);
          removeThreadIdsFromCache([current.threadId]);
          await showNext(1, true);
          return;
        }
        if (choice === "replyNext") {
          const reply = await composeReply(ctx, current, async (body) => {
            await sendReply(current, body);
          });
          if (!reply.sent) {
            message = "Reply cancelled.";
            tui.requestRender();
            return;
          }
          ctx.ui.notify(`sent reply to ${currentLabel(current)}`, "info");
          processing = true;
          message = "Reply sent. Loading next inbox email…";
          tui.requestRender();
          try {
            await showNext(1, true);
          } catch (error) {
            processing = false;
            message = `Reply sent, but loading the next email failed: ${error instanceof Error ? error.message : String(error)}`;
            tui.requestRender();
          }
          return;
        }
        if (choice === "unsubscribeOpen") {
          if (current.chosenUnsubscribeUrl) {
            await execFileAsync("open", [current.chosenUnsubscribeUrl]);
            message = `Opened unsubscribe link for ${currentLabel(current)}`;
          } else {
            message = "No unsubscribe link found for this message.";
          }
          tui.requestRender();
          return;
        }
        if (choice === "unsubscribeArchiveSender") {
          if (!current.chosenUnsubscribeUrl) {
            message = "No unsubscribe link found for this message.";
            tui.requestRender();
            return;
          }
          processing = true;
          message = `Opening unsubscribe and archiving ${currentLabel(current)}…`;
          tui.requestRender();
          await execFileAsync("open", [current.chosenUnsubscribeUrl]);
          const { query, threadIds } = await collectInboxThreadIdsFromSender(current);
          await archiveThreadIds(threadIds, (completed, total) => {
            message = `Archiving sender threads ${completed}/${total}…`;
            tui.requestRender();
          });
          removeThreadIdsFromCache(threadIds);
          nextItemPromise = null;
          ctx.ui.notify(`opened unsubscribe link and archived ${threadIds.length} inbox thread(s) using query: ${query}`, "info");
          await showNext(1, false);
          return;
        }
        if (choice === "archiveSimilar" || choice === "trashSimilar") {
          processing = true;
          message = `Finding messages like ${currentLabel(current)}…`;
          tui.requestRender();
          const isTrash = choice === "trashSimilar";
          const result = await confirmBulkAction(ctx, isTrash ? "trash messages like this" : "archive messages like this", current);
          if (!result.confirmed) {
            await showNext(1, true);
            return;
          }
          const { query, threadIds } = result.selection;
          message = `${isTrash ? "Moving" : "Archiving"} ${threadIds.length} similar thread(s)…`;
          tui.requestRender();
          const reportProgress = (completed: number, total: number) => {
            message = `${isTrash ? "Moving to trash" : "Archiving"} similar threads ${completed}/${total}…`;
            tui.requestRender();
          };
          if (isTrash) await trashThreadIds(threadIds, reportProgress);
          else await archiveThreadIds(threadIds, reportProgress);
          removeThreadIdsFromCache(threadIds);
          nextItemPromise = null;
          ctx.ui.notify(`${isTrash ? "moved" : "archived"} ${threadIds.length} similar inbox thread(s) using query: ${query}`, "info");
          await showNext(1, false);
        }
      } catch (error) {
        message = `Action failed: ${error instanceof Error ? error.message : String(error)}`;
        processing = false;
        tui.requestRender();
      }
    };

    setTimeout(() => void showNext(1, false), 0);

    return {
      render(width: number) {
        if (helpVisible) {
          return boxedLines(
            "Email Help",
            inboxHelpLines(),
            "? / q / Esc Close  ·  ↑/↓ Scroll  ·  Ctrl-U/Ctrl-D Scroll",
            width,
            theme,
            helpScrollOffset,
          );
        }
        const body = item ? formatInboxSweepPrompt(item).split("\n") : [message];
        if (processing) body.push("", theme?.fg ? theme.fg("muted", message) : message);
        return boxedLines(
          "Email",
          body,
          "Return/e Archive  ·  # Trash  ·  ! Spam  ·  r Reply  ·  j/k Move  ·  ? Help  ·  q Quit",
          width,
          theme,
          messageScrollOffset,
        );
      },
      handleInput(data: string) {
        if (matchesKey(data, Key.up)) {
          adjustScroll(-1);
          return;
        }
        if (matchesKey(data, Key.down)) {
          adjustScroll(1);
          return;
        }
        if (matchesKey(data, Key.pageUp) || matchesKey(data, Key.ctrl("u"))) {
          adjustScroll(-10);
          return;
        }
        if (matchesKey(data, Key.pageDown) || matchesKey(data, Key.ctrl("d"))) {
          adjustScroll(10);
          return;
        }
        if (helpVisible) {
          if (data === "?" || data === "q" || matchesKey(data, Key.escape)) {
            helpVisible = false;
            tui.requestRender();
          }
          return;
        }
        if (data === "?") {
          helpVisible = true;
          helpScrollOffset = 0;
          tui.requestRender();
          return;
        }
        const action = actionForKey(data, INBOX_SWEEP_ACTIONS);
        if (action) void act(action);
      },
      invalidate() {},
    };
  }, emailOverlayOptions());
}
