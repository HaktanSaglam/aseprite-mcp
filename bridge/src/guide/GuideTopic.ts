export interface GuideTopic {
  /** Stable id the model passes to pixel_art_guide. */
  id: string;
  title: string;
  /** One line shown in the topic list: when to read this topic. */
  summary: string;
  body: string;
}
