/** Key for runs that are not bound to a sprite (chat with nothing open); sprite ids start at 1. */
const NO_SPRITE = 0;

/**
 * Conversation memory per sprite: a follow-up ("make it darker") continues the run that
 * drew that sprite. Only the provider that created a conversation can resume it, so
 * switching providers starts fresh.
 */
export class SessionStore {
  private readonly bySprite = new Map<number, { provider: string; sessionId: string }>();

  get(provider: string, sprite?: number): string | undefined {
    const entry = this.bySprite.get(sprite ?? NO_SPRITE);
    return entry?.provider === provider ? entry.sessionId : undefined;
  }

  set(provider: string, sprite: number | undefined, sessionId: string): void {
    this.bySprite.set(sprite ?? NO_SPRITE, { provider, sessionId });
  }

  clear(): void {
    this.bySprite.clear();
  }
}
