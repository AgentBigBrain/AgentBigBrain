/**
 * @fileoverview Renders open-loop notes from the Stage 6.86 conversation stack for the Obsidian projection sink.
 */

import type { ProjectionSnapshot } from "../contracts";
import {
  renderMarkdownList,
  renderObsidianFrontmatter,
  type ObsidianProjectedNote
} from "./obsidianFrontmatter";
import {
  buildOpenLoopNoteRelativePath,
  buildProjectionLinkIndex,
  renderObsidianWikiLink
} from "./obsidianLinks";

type ConversationStackThreadLike = {
  threadKey: string;
  topicLabel?: string | null;
  openLoops?: ReadonlyArray<{
    loopId: string;
    status?: string;
    entityRefs?: readonly string[];
    lastUpdatedAt?: string;
  }>;
};

/**
 * Renders one Markdown note per open loop in the current conversation stack.
 *
 * **Why it exists:**
 * Open loops bridge continuity, follow-up UX, and memory review, so operators need direct notes
 * for them instead of only seeing collapsed thread JSON inside runtime state.
 *
 * **What it talks to:**
 * - Uses `ProjectionSnapshot` from `../contracts`.
 * - Uses rendering helpers from `./obsidianFrontmatter`.
 *
 * @param snapshot - Full projection snapshot.
 * @returns Projected open-loop notes keyed by stable relative vault paths.
 */
export function renderObsidianLoopNotes(
  snapshot: ProjectionSnapshot
): readonly ObsidianProjectedNote[] {
  const threads = snapshot.runtimeState.conversationStack.threads as unknown as readonly ConversationStackThreadLike[];
  const linkIndex = buildProjectionLinkIndex(snapshot);
  const notes: ObsidianProjectedNote[] = [];

  for (const thread of threads) {
    for (const loop of thread.openLoops ?? []) {
      const loopText = loop.loopId;
      const stableLoopId = loop.loopId;
      const entityLinks = (loop.entityRefs ?? []).map((entityRef) => {
        const entityPath = linkIndex.entityPathsByKey.get(entityRef);
        const label = linkIndex.entityLabelsByKey.get(entityRef) ?? entityRef;
        return entityPath
          ? renderObsidianWikiLink(entityPath, label)
          : label;
      });
      notes.push({
        relativePath: buildOpenLoopNoteRelativePath(stableLoopId),
        content: [
          renderObsidianFrontmatter({
            abb_id: stableLoopId,
            abb_type: "open_loop",
            thread_key: thread.threadKey,
            status: loop.status ?? "active",
            updated_at: loop.lastUpdatedAt ?? snapshot.runtimeState.updatedAt
          }),
          `# ${loopText}`,
          "",
          "## Thread",
          `- ${thread.topicLabel ?? thread.threadKey}`,
          "",
          "## Related Entities",
          renderMarkdownList(entityLinks)
        ].join("\n")
      });
    }
  }

  return notes;
}
