import { describe, it, expect } from "vitest";
import { InProcessBus } from "../src/bus/in-process.js";

describe("InProcessBus", () => {
  it("publishes and subscribes to events", async () => {
    const bus = new InProcessBus();
    const received: unknown[] = [];

    bus.subscribe("test:event", async (event) => {
      received.push(event);
    });

    await bus.publish({
      type: "test:event",
      meta: { id: "1", timestamp: new Date().toISOString(), runId: "run-1" },
      payload: { data: "hello" },
    });

    expect(received.length).toBe(1);
    expect((received[0] as { payload: { data: string } }).payload.data).toBe("hello");

    await bus.close();
  });

  it("waitFor resolves on matching event", async () => {
    const bus = new InProcessBus();

    const promise = bus.waitFor("test:event", undefined, 1000);

    setTimeout(() => {
      bus.publish({
        type: "test:event",
        meta: { id: "1", timestamp: new Date().toISOString(), runId: "run-1" },
        payload: { data: "resolved" },
      });
    }, 50);

    const event = await promise;
    expect((event as { payload: { data: string } }).payload.data).toBe("resolved");

    await bus.close();
  });

  it("does not publish after close", async () => {
    const bus = new InProcessBus();
    const received: unknown[] = [];

    bus.subscribe("test:event", async (event) => {
      received.push(event);
    });

    await bus.close();

    await bus.publish({
      type: "test:event",
      meta: { id: "1", timestamp: new Date().toISOString(), runId: "run-1" },
      payload: {},
    });

    expect(received.length).toBe(0);
  });
});
