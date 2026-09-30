// Thin typed wrappers over the three TinyFish endpoints we use.
// Docs: https://docs.tinyfish.ai/for-coding-agents

const SEARCH_URL = "https://api.search.tinyfish.ai";
const FETCH_URL = "https://api.fetch.tinyfish.ai";
const AGENT_URL = "https://agent.tinyfish.ai/v1/automation/run";

/** Raised for any TinyFish failure so callers can tell the user *which* source failed. */
export class TinyFishError extends Error {
  constructor(
    readonly endpoint: "search" | "fetch" | "agent",
    message: string,
    readonly status?: number,
  ) {
    super(`TinyFish ${endpoint}: ${message}`);
  }
}

function apiKey(): string {
  const key = process.env.TINYFISH_API_KEY;
  if (!key) throw new TinyFishError("search", "TINYFISH_API_KEY is not set in .env");
  return key;
}

async function request(
  endpoint: TinyFishError["endpoint"],
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<unknown> {
  for (let attempt = 0; ; attempt++) {
    let res: Response;
    try {
      res = await fetch(url, {
        ...init,
        headers: { "X-API-Key": apiKey(), "Content-Type": "application/json", ...init.headers },
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      if (attempt === 0) continue;
      throw new TinyFishError(endpoint, err instanceof Error ? err.message : String(err));
    }
    // One retry on rate limits and server errors.
    if ((res.status === 429 || res.status >= 500) && attempt === 0) {
      await new Promise((r) => setTimeout(r, res.status === 429 ? 3000 : 1000));
      continue;
    }
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new TinyFishError(endpoint, `HTTP ${res.status} ${body.slice(0, 200)}`, res.status);
    }
    return res.json();
  }
}

// ---------- Search ----------

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

export interface SearchOptions {
  purpose?: string;
  includeDomains?: string[];
  recencyMinutes?: number;
  location?: string;
}

export async function search(query: string, opts: SearchOptions = {}): Promise<SearchResult[]> {
  const params = new URLSearchParams({ query, location: opts.location ?? "US", language: "en" });
  if (opts.purpose) params.set("purpose", opts.purpose);
  if (opts.recencyMinutes) params.set("recency_minutes", String(opts.recencyMinutes));
  for (const d of opts.includeDomains ?? []) params.append("include_domains", d);

  const data = (await request("search", `${SEARCH_URL}?${params}`, { method: "GET" }, 15_000)) as {
    results?: Array<Record<string, unknown>>;
  };
  return (data.results ?? [])
    .map((r) => ({
      title: String(r.title ?? ""),
      url: String(r.url ?? r.link ?? ""),
      snippet: String(r.snippet ?? r.description ?? r.content ?? ""),
    }))
    .filter((r) => r.url);
}

// ---------- Fetch ----------

export interface FetchedPage {
  url: string;
  title: string;
  text: string;
  /** Outgoing links on the page (only when requested with `links: true`). */
  links: string[];
  etag?: string;
  lastModified?: string;
}

export interface FetchFailure {
  url: string;
  error: string;
  status?: number;
}

export interface FetchOptions {
  format?: "markdown" | "html" | "json";
  purpose?: string;
  /** Cache window in seconds; 0 forces a live fetch. */
  ttl?: number;
  perUrlTimeoutMs?: number;
  /** Also return each page's outgoing links (used to crawl course sites). */
  links?: boolean;
}

export async function fetchPages(
  urls: string[],
  opts: FetchOptions = {},
): Promise<{ pages: FetchedPage[]; failures: FetchFailure[] }> {
  const body: Record<string, unknown> = {
    urls,
    format: opts.format ?? "markdown",
    per_url_timeout_ms: opts.perUrlTimeoutMs ?? 60_000,
  };
  if (opts.purpose) body.purpose = opts.purpose.slice(0, 2000);
  if (opts.ttl !== undefined) body.ttl = opts.ttl;
  if (opts.links) body.links = true;

  const data = (await request(
    "fetch",
    FETCH_URL,
    { method: "POST", body: JSON.stringify(body) },
    150_000,
  )) as { results?: Array<Record<string, unknown>>; errors?: Array<Record<string, unknown>> };

  const pages = (data.results ?? []).map((r) => ({
    url: String(r.url ?? r.final_url ?? ""),
    title: String(r.title ?? ""),
    // With format "json" the text field may already be an object.
    text: typeof r.text === "string" ? r.text : JSON.stringify(r.text ?? ""),
    links: Array.isArray(r.links)
      ? r.links.map((l) => (typeof l === "string" ? l : String((l as { url?: string; href?: string }).url ?? (l as { href?: string }).href ?? ""))).map((l) => l.trim()).filter(Boolean)
      : [],
    etag: r.etag ? String(r.etag) : undefined,
    lastModified: r.last_modified ? String(r.last_modified) : undefined,
  }));
  const failures = (data.errors ?? []).map((e) => ({
    url: String(e.url ?? ""),
    error: String(e.error ?? "unknown_error"),
    status: typeof e.status === "number" ? e.status : undefined,
  }));
  return { pages, failures };
}

/** Fetch exactly one URL; throws if TinyFish couldn't read it. */
export async function fetchPage(url: string, opts: FetchOptions = {}): Promise<FetchedPage> {
  const { pages, failures } = await fetchPages([url], opts);
  const page = pages[0];
  if (!page) {
    const f = failures[0];
    throw new TinyFishError("fetch", `${f?.error ?? "no result"} for ${url}`, f?.status);
  }
  return page;
}

// ---------- Agent ----------

export interface AgentRun<T> {
  runId: string;
  status: string;
  steps: number;
  result: T | null;
}

export interface AgentOptions {
  url: string;
  goal: string;
  outputSchema?: Record<string, unknown>;
  stealth?: boolean;
  maxSteps?: number;
  maxDurationSeconds?: number;
  /** Reuse a saved logged-in Browser Context Profile (e.g. Gradescope). */
  profileId?: string;
}

/**
 * The Agent accepts a subset of JSON Schema: no `description` keys and no type arrays
 * (use `nullable: true`). Normalize so callers can write ordinary schemas.
 */
export function agentSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(agentSchema);
  if (!schema || typeof schema !== "object") return schema;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema)) {
    if (key === "description") continue;
    if (key === "type" && Array.isArray(value)) {
      const types = value.filter((t) => t !== "null");
      out.type = types[0];
      if (types.length !== value.length) out.nullable = true;
      continue;
    }
    // Inside `properties`, keys are field names (a field may be called "description").
    out[key] =
      key === "properties" && value && typeof value === "object"
        ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, agentSchema(v)]))
        : agentSchema(value);
  }
  return out;
}

export async function runAgent<T = unknown>(opts: AgentOptions): Promise<AgentRun<T>> {
  const body: Record<string, unknown> = {
    url: opts.url,
    goal: opts.goal,
    browser_profile: opts.stealth ? "stealth" : "lite",
    agent_config: {
      max_duration_seconds: opts.maxDurationSeconds ?? 120,
      // Custom step limits need TinyFish's beta program; opt in with TINYFISH_CUSTOM_STEPS=1.
      ...(process.env.TINYFISH_CUSTOM_STEPS === "1" && opts.maxSteps ? { max_steps: opts.maxSteps } : {}),
    },
  };
  if (opts.outputSchema) body.output_schema = agentSchema(opts.outputSchema);
  if (opts.profileId) Object.assign(body, { use_profile: true, profile_id: opts.profileId });

  const timeoutMs = ((opts.maxDurationSeconds ?? 120) + 30) * 1000;
  const data = (await request(
    "agent",
    AGENT_URL,
    { method: "POST", body: JSON.stringify(body) },
    timeoutMs,
  )) as Record<string, unknown>;

  const status = String(data.status ?? "UNKNOWN");
  if (status !== "COMPLETED") {
    throw new TinyFishError("agent", `run ${String(data.run_id)} ended ${status}: ${JSON.stringify(data.error)}`);
  }
  // COMPLETED doesn't mean the goal succeeded: callers must still check the result.
  return {
    runId: String(data.run_id ?? ""),
    status,
    steps: Number(data.num_of_steps ?? 0),
    result: (data.result as T) ?? null,
  };
}
