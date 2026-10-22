import type { AsepriteEvent, IAsepriteEvents } from "../aseprite/AsepriteSocket.js";

type Listener = (event: AsepriteEvent) => void;

function subscribe(list: Listener[], listener: Listener): () => void {
  list.push(listener);
  return () => {
    const i = list.indexOf(listener);
    if (i >= 0) list.splice(i, 1);
  };
}

/**
 * Decorator over the real Aseprite event channel for development: tests and eval
 * scripts can inject events as if the Aseprite window had sent them, and watch what
 * the bridge sends back. Everything still reaches the real Aseprite too.
 */
export class TappedEvents implements IAsepriteEvents {
  private readonly handlers: Listener[] = [];
  private readonly outgoing: Listener[] = [];
  private readonly incoming: Listener[] = [];

  constructor(private readonly inner: IAsepriteEvents) {
    inner.onEvent((event) => this.dispatch(event));
  }

  onEvent(handler: Listener): void {
    this.handlers.push(handler);
  }

  onConnectionChange(handler: (connected: boolean) => void): void {
    this.inner.onConnectionChange(handler);
  }

  notify(event: AsepriteEvent): void {
    this.inner.notify(event);
    for (const listener of this.outgoing) listener(event);
  }

  /** As if the Aseprite extension had sent `event`. */
  inject(event: AsepriteEvent): void {
    this.dispatch(event);
  }

  /** Observe bridge → Aseprite events; returns an unsubscribe function. */
  watch(listener: Listener): () => void {
    return subscribe(this.outgoing, listener);
  }

  /** Observe Aseprite → bridge events (e.g. ui_debug_result); returns an unsubscribe function. */
  watchIncoming(listener: Listener): () => void {
    return subscribe(this.incoming, listener);
  }

  private dispatch(event: AsepriteEvent): void {
    for (const handler of this.handlers) handler(event);
    for (const listener of [...this.incoming]) listener(event);
  }
}
