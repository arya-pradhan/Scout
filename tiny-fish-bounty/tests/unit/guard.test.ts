import { blockedRequests } from "../setup.ts";
import assert from "node:assert/strict";
import test from "node:test";
import { z } from "zod";
import { extract } from "../../src/llm.ts";
import { search } from "../../src/tinyfish.ts";

// Proves the test setup can't spend money: Claude and TinyFish calls fail instead of going out.
test("Claude calls are blocked in unit tests", async () => {
  await assert.rejects(extract(z.object({ ok: z.boolean() }), "test", "test"));
  assert.ok(blockedRequests.some((u) => u.startsWith("http://127.0.0.1:9")), "the request never left the machine");
});

test("TinyFish calls are blocked in unit tests", async () => {
  await assert.rejects(search("anything"));
  assert.ok(blockedRequests.some((u) => u.includes("tinyfish.ai")));
});
