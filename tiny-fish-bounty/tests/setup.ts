// Offline test setup: every unit test imports this FIRST.
// - The network is replaced: any request a test didn't explicitly mock throws, so a unit
//   test can never call Claude or TinyFish (and never spends credits).
// - State goes to a throwaway temp file, never data/state.json.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.STATE_PATH = join(mkdtempSync(join(tmpdir(), "scout-test-")), "state.json");
process.env.ANTHROPIC_API_KEY = "test-no-calls";
process.env.ANTHROPIC_BASE_URL = "http://127.0.0.1:9";
process.env.TINYFISH_API_KEY = "test-no-calls";
process.env.TZ_NAME = "America/New_York";
process.env.ALLOWED_PHONES = "";

type Handler = (url: string, init?: RequestInit) => Response | Promise<Response> | undefined;
let handler: Handler | undefined;
export const blockedRequests: string[] = [];

/** Answer requests in this test. Return undefined to fall through to "blocked". */
export function mockFetch(h: Handler): void {
  handler = h;
}

export function resetFetch(): void {
  handler = undefined;
}

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const res = await handler?.(url, init);
  if (res) return res;
  blockedRequests.push(url);
  throw new Error(`Network is disabled in unit tests (tried ${url})`);
}) as typeof fetch;

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}
