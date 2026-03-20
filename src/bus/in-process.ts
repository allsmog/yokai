import type { AnyEvent, MessageBus } from "./types.js";

type Handler = (event: AnyEvent) => Promise<void> | void;

export class InProcessBus implements MessageBus {
  private handlers = new Map<string, Set<Handler>>();
  private closed = false;

  async publish<E extends AnyEvent>(event: E): Promise<void> {
    if (this.closed) return;
    const handlers = this.handlers.get(event.type);
    if (!handlers) return;
    for (const handler of handlers) {
      try {
        await handler(event as AnyEvent);
      } catch (error) {
        console.error(`[bus] Handler error for ${event.type}:`, error);
      }
    }
  }

  subscribe<E extends AnyEvent>(eventType: E["type"], handler: (event: E) => Promise<void> | void): void {
    if (!this.handlers.has(eventType)) {
      this.handlers.set(eventType, new Set());
    }
    this.handlers.get(eventType)!.add(handler as Handler);
  }

  unsubscribe(eventType: string, handler: Function): void {
    this.handlers.get(eventType)?.delete(handler as Handler);
  }

  waitFor<E extends AnyEvent>(
    eventType: E["type"],
    predicate?: (event: E) => boolean,
    timeoutMs = 300_000,
  ): Promise<E> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.unsubscribe(eventType, handler);
        reject(new Error(`waitFor("${eventType}") timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      const handler = (event: AnyEvent) => {
        const typed = event as E;
        if (!predicate || predicate(typed)) {
          clearTimeout(timer);
          this.unsubscribe(eventType, handler);
          resolve(typed);
        }
      };

      this.subscribe(eventType, handler as (event: E) => void);
    });
  }

  async close(): Promise<void> {
    this.closed = true;
    this.handlers.clear();
  }
}
