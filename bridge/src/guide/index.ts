import type { GuideTopic } from "./GuideTopic.js";
import { animation } from "./topics/animation.js";
import { characters } from "./topics/characters.js";
import { colorPalettes } from "./topics/colorPalettes.js";
import { environments } from "./topics/environments.js";
import { fundamentals } from "./topics/fundamentals.js";
import { itemsIcons } from "./topics/itemsIcons.js";
import { outlinesAa } from "./topics/outlinesAa.js";
import { shadingLight } from "./topics/shadingLight.js";
import { styles } from "./topics/styles.js";
import { tiles } from "./topics/tiles.js";
import { workflow } from "./topics/workflow.js";

export type { GuideTopic } from "./GuideTopic.js";

/** Listing order: general first, then subjects, then this toolset's workflow. */
export const GUIDE_TOPICS: readonly GuideTopic[] = [
  fundamentals,
  characters,
  animation,
  tiles,
  itemsIcons,
  environments,
  shadingLight,
  colorPalettes,
  outlinesAa,
  styles,
  workflow,
];

export const TOPIC_IDS = GUIDE_TOPICS.map((t) => t.id) as [string, ...string[]];

export function findTopic(id: string): GuideTopic | undefined {
  return GUIDE_TOPICS.find((t) => t.id === id);
}

/** The answer to pixel_art_guide without arguments: what exists and when to read it. */
export function topicIndex(): string {
  const lines = GUIDE_TOPICS.map((t) => `- ${t.id}: ${t.summary}`);
  return [
    "Pixel art guide topics. Call pixel_art_guide with {topic} (or several: {topic: [..]}) before a",
    "big or unfamiliar task; each topic is ~500-900 words with numbers, recipes and tested",
    "draw_script examples.",
    ...lines,
  ].join("\n");
}
