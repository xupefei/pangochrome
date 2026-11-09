import { describe, expect, it } from "vitest";
import { SerialQueue } from "./serial";

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe("SerialQueue", () => {
  it("starts the second task only after the first has finished", async () => {
    const queue = new SerialQueue();
    const gate = deferred<void>();
    const order: string[] = [];

    const first = queue.run(async () => {
      order.push("first start");
      await gate.promise;
      order.push("first end");
      return 1;
    });
    const second = queue.run(async () => {
      order.push("second");
      return 2;
    });

    await Promise.resolve();
    expect(order).toEqual(["first start"]);

    gate.resolve();
    await expect(first).resolves.toBe(1);
    await expect(second).resolves.toBe(2);
    expect(order).toEqual(["first start", "first end", "second"]);
  });

  it("keeps running later tasks after one rejects", async () => {
    const queue = new SerialQueue();
    const failed = queue.run(async () => {
      throw new Error("boom");
    });
    const next = queue.run(async () => "after");

    await expect(failed).rejects.toThrow("boom");
    await expect(next).resolves.toBe("after");
  });
});
