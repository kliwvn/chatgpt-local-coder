import assert from "node:assert/strict";

import {
  enqueueKeyedMutation,
  pruneExpiredCache,
  retryTransientFsMutation,
} from "../manager/fs-utils.mjs";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Same-key work must serialize, and the queue must not retain settled keys.
{
  const chains = new Map();
  const order = [];
  const first = enqueueKeyedMutation(chains, "same", async () => {
    order.push("first-start");
    await sleep(30);
    order.push("first-end");
  });
  const second = enqueueKeyedMutation(chains, "same", async () => {
    order.push("second-start");
    order.push("second-end");
  });
  await Promise.all([first, second]);
  await Promise.resolve();
  assert.deepEqual(order, ["first-start", "first-end", "second-start", "second-end"]);
  assert.equal(chains.size, 0, "settled keyed mutations must release Map keys");
}

// TTL cache pruning must remove old/invalid entries while retaining fresh ones.
{
  const cache = new Map([
    ["old", { at: 100 }],
    ["fresh", { at: 950 }],
    ["invalid", {}],
  ]);
  pruneExpiredCache(cache, 200, 1000);
  assert.deepEqual([...cache.keys()], ["fresh"]);
}

// Retriable filesystem errors must be bounded and surface after exhaustion.
{
  let attempts = 0;
  await assert.rejects(
    retryTransientFsMutation(
      async () => {
        attempts++;
        throw Object.assign(new Error("busy forever"), { code: "EBUSY" });
      },
      { attempts: 3, baseDelayMs: 1 }
    ),
    /busy forever/
  );
  assert.equal(attempts, 3);
}

// A transient failure followed by success should return the successful value.
{
  let attempts = 0;
  const value = await retryTransientFsMutation(
    async () => {
      attempts++;
      if (attempts < 2) throw Object.assign(new Error("temporary access"), { code: "EACCES" });
      return "ok";
    },
    { attempts: 3, baseDelayMs: 1 }
  );
  assert.equal(value, "ok");
  assert.equal(attempts, 2);
}

console.log("manager-fs-utils: ok (mutation keys released, TTL cache pruned, retry exhaustion surfaced)");