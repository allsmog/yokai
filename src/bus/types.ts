export interface EventMeta {
  id: string;
  timestamp: string;
  runId: string;
}

export type EventEnvelope<T extends string = string, P = unknown> = {
  type: T;
  meta: EventMeta;
  payload: P;
};

export type AnyEvent = EventEnvelope<string, unknown>;

export interface MessageBus {
  publish<E extends AnyEvent>(event: E): Promise<void>;
  subscribe<E extends AnyEvent>(eventType: E["type"], handler: (event: E) => Promise<void> | void): void;
  unsubscribe(eventType: string, handler: Function): void;
  waitFor<E extends AnyEvent>(eventType: E["type"], predicate?: (event: E) => boolean, timeoutMs?: number): Promise<E>;
  close(): Promise<void>;
}
