import { findTopic } from "../guide/index.js";
import type { ChatAction } from "./chatSchema.js";

// Keywords in English and Turkish (the project's first users); anything else falls back
// to the model calling pixel_art_guide itself. JS \b ignores non-ASCII letters, so word
// starts are matched with a Unicode lookbehind instead ("şövalye", "ışık").
const words = (list: string) => new RegExp(`(?<!\\p{L})(${list})`, "iu");

// Order matters: "a knight with a sword" is a character, "a forest with a cabin" a scene.
const TOPIC_KEYWORDS: [topic: string, words: RegExp][] = [
  ["tiles", words("tile|tileset|tilemap|seamless|autotile|karo|döşeme")],
  [
    "environments",
    words(
      "scene|landscape|background|backdrop|forest|city|town|village|room|interior|sky|sunset|dusk|night|cave|dungeon|castle|beach|mountain|parallax|" +
        "sahne|manzara|arka ?plan|orman|şehir|kasaba|köy|oda|gökyüzü|gün batımı|mağara|zindan|kale|sahil|dağ",
    ),
  ],
  [
    "characters",
    words(
      "character|hero|heroine|knight|warrior|soldier|wizard|mage|witch|rogue|archer|princess|king|girl|boy|man|woman|person|npc|monster|slime|enemy|creature|animal|cat|dog|bird|dragon|robot|zombie|skeleton|ghost|player|" +
        "karakter|kahraman|şövalye|savaşçı|asker|büyücü|cadı|okçu|prenses|kral|kız|oğlan|adam|kadın|canavar|düşman|yaratık|hayvan|kedi|köpek|kuş|ejderha|iskelet|hayalet|oyuncu",
    ),
  ],
  [
    "items_icons",
    words(
      "icon|item|sword|axe|bow|staff|wand|potion|weapon|shield|armor|helmet|gem|crystal|coin|chest|key|food|apple|bottle|book|scroll|ring|tool|pickaxe|hammer|" +
        "ikon|simge|eşya|kılıç|balta|yay|asa|iksir|silah|kalkan|zırh|miğfer|mücevher|kristal|altın|sandık|anahtar|yiyecek|elma|şişe|kitap|yüzük|kazma|çekiç",
    ),
  ],
];

/**
 * The guide topic most relevant to a request. Inlining it saves the model a tool round
 * trip, and in practice models rarely call pixel_art_guide on their own.
 */
export function guideTopicFor(action: ChatAction, text: string): string | undefined {
  if (action === "animate") return "animation";
  if (action === "directions") return "characters";
  if (!["generate", "variations", "batch"].includes(action)) return undefined;
  return TOPIC_KEYWORDS.find(([, words]) => words.test(text))?.[0];
}

export function guideReference(topicId: string | undefined): string | undefined {
  const topic = topicId ? findTopic(topicId) : undefined;
  if (!topic) return undefined;
  return `Reference — pixel-art guide, "${topic.id}" (already loaded, no need to call pixel_art_guide for it):\n\n${topic.body}`;
}
