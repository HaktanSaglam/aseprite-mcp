import { z } from "zod";
import { findTopic, TOPIC_IDS, topicIndex } from "../../guide/index.js";
import type { ToolRegistrar } from "../ToolContext.js";

const MAX_TOPICS_PER_CALL = 3;

/** Topic text for pixel_art_guide: the index without a topic, otherwise the topics in order. */
export function guideText(topic: string | string[] | undefined): string {
  if (topic === undefined || (Array.isArray(topic) && topic.length === 0)) return topicIndex();
  const ids = [...new Set(Array.isArray(topic) ? topic : [topic])];
  return ids
    .map((id) => {
      const found = findTopic(id);
      // zod already restricts ids; this guards direct (in-process) callers.
      if (!found) throw new Error(`Unknown topic "${id}". Topics: ${TOPIC_IDS.join(", ")}`);
      return found.body;
    })
    .join("\n\n---\n\n");
}

export const registerGuideTools: ToolRegistrar = (server) => {
  const topicId = z.enum(TOPIC_IDS);
  server.registerTool(
    "pixel_art_guide",
    {
      title: "Pixel art guide",
      description:
        "Expert pixel-art knowledge as concise, numeric recipes with tested draw_script examples. " +
        "Read the relevant topic BEFORE a big or unfamiliar task (a character, animation, tileset, " +
        "scene, icon set, a named style); it is much cheaper than redrawing. No topic returns the list. " +
        `Topics: ${TOPIC_IDS.join(", ")}.`,
      inputSchema: {
        topic: z
          .union([topicId, z.array(topicId).max(MAX_TOPICS_PER_CALL)])
          .optional()
          .describe(`One topic id or up to ${MAX_TOPICS_PER_CALL} ids. Omit to list topics with summaries.`),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ topic }) => ({ content: [{ type: "text", text: guideText(topic) }] }),
  );
};
