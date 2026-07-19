import { describe, expect, it, vi } from "vitest";
import { runIfNotInFlight } from "./actionLock";

function deferred() {
  let resolve!: () => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

describe("action lock", () => {
  it("excludes a second operation immediately and releases after success", async () => {
    const lock = { current: false };
    const pending = deferred();
    const operation = vi.fn(() => pending.promise);

    const first = runIfNotInFlight(lock, operation);
    await expect(runIfNotInFlight(lock, operation)).resolves.toBe(false);
    expect(operation).toHaveBeenCalledOnce();

    pending.resolve();
    await expect(first).resolves.toBe(true);
    await expect(runIfNotInFlight(lock, operation)).resolves.toBe(true);
    expect(operation).toHaveBeenCalledTimes(2);
  });

  it("releases after an asynchronous rejection", async () => {
    const lock = { current: false };
    const pending = deferred();

    const first = runIfNotInFlight(lock, () => pending.promise);
    pending.reject(new Error("launch failed"));

    await expect(first).rejects.toThrow("launch failed");
    await expect(runIfNotInFlight(lock, async () => undefined)).resolves.toBe(true);
  });

  it("releases after a synchronous throw", async () => {
    const lock = { current: false };

    await expect(runIfNotInFlight(lock, () => {
      throw new Error("invalid launch");
    })).rejects.toThrow("invalid launch");
    await expect(runIfNotInFlight(lock, async () => undefined)).resolves.toBe(true);
  });
});
