// Campus events from wherever the student's school posts them.
//
// - Campus Labs Engage (student-org sites at many schools): public JSON search API.
// - Localist (a common university calendar): public JSON API.
// Both are already structured data, so they're read directly (TinyFish Fetch converts
// responses into readable text, which would lose the records).
// - Anything else: TinyFish Fetch reads the events page and Claude pulls out the events.
//   Items without a date are dropped; the bot never guesses when something happens.

import { createHash } from "node:crypto";
import { z } from "zod";
import { currentTimezone, localDay, SITE_MODEL } from "../config.ts";
import { extract } from "../llm.ts";
import { knownEvent, rememberEvents, type CampusEvent, type EventSource, type UserState } from "../store.ts";
import { fetchPage, search, type SearchResult } from "../tinyfish.ts";

export type { CampusEvent };

export interface EventQuery {
  from?: Date;
  to?: Date;
  keywords?: string[];
  freeFood?: boolean;
  eveningsOnly?: boolean;
  /** "all" (default): must have free food AND match a keyword. "any": either one. */
  match?: "all" | "any";
  limit?: number;
}

const FOOD_RE = /free food|pizza|snacks|refreshments|food (will be )?provided|lunch (is )?provided|dinner (is )?provided|free lunch|free dinner|free breakfast|boba|donuts/i;

function stripHtml(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&[a-z#0-9]+;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// 10-minute cache per request URL: events don't change minute to minute.
const jsonCache = new Map<string, { at: number; data: unknown }>();

async function getJson(url: string): Promise<unknown> {
  const hit = jsonCache.get(url);
  if (hit && Date.now() - hit.at < 10 * 60_000) return hit.data;
  const res = await fetch(url, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`${new URL(url).host} returned HTTP ${res.status}`);
  const data = await res.json();
  jsonCache.set(url, { at: Date.now(), data });
  return data;
}

// ---------- Engage ----------

async function engageEvents(host: string, from: Date): Promise<CampusEvent[]> {
  // Round the window start down to 10 minutes so repeat questions hit the cache.
  const rounded = new Date(Math.floor(from.getTime() / 600_000) * 600_000);
  const params = new URLSearchParams({
    endsAfter: rounded.toISOString(),
    orderByField: "endsOn",
    orderByDirection: "ascending",
    status: "Approved",
    take: "100",
    query: "",
  });
  const data = (await getJson(`https://${host}/api/discovery/event/search?${params}`)) as { value?: Array<Record<string, unknown>> };
  return (data.value ?? []).map((e) => ({
    id: `engage:${host}:${String(e.id)}`,
    name: String(e.name ?? ""),
    org: String(e.organizationName ?? ""),
    location: String(e.location ?? "TBA"),
    start: new Date(String(e.startsOn)).toISOString(),
    end: new Date(String(e.endsOn)).toISOString(),
    perks: (e.benefitNames as string[] | undefined) ?? [],
    categories: (e.categoryNames as string[] | undefined) ?? [],
    summary: stripHtml(String(e.description ?? "")).slice(0, 280),
    url: `https://${host}/event/${String(e.id)}`,
  }));
}

async function engageEventById(host: string, rawId: string): Promise<CampusEvent | undefined> {
  const e = (await getJson(`https://${host}/api/discovery/event/${encodeURIComponent(rawId)}`).catch(() => null)) as Record<
    string,
    unknown
  > | null;
  if (!e) return undefined;
  const address = e.address as { name?: string; address?: string } | undefined;
  return {
    id: `engage:${host}:${String(e.id)}`,
    name: String(e.name ?? ""),
    org: String(e.organizationName ?? ""),
    location: address?.name ?? address?.address ?? "TBA",
    start: new Date(String(e.startsOn)).toISOString(),
    end: new Date(String(e.endsOn)).toISOString(),
    perks: ((e.benefits as string[] | undefined) ?? []).map((b) => (b === "FreeFood" ? "Free Food" : b)),
    categories: [],
    summary: stripHtml(String(e.description ?? "")).slice(0, 280),
    url: `https://${host}/event/${String(e.id)}`,
  };
}

// ---------- Localist ----------

async function localistEvents(host: string, from: Date, to: Date): Promise<CampusEvent[]> {
  const days = Math.min(90, Math.max(1, Math.ceil((to.getTime() - from.getTime()) / 86_400_000) + 1));
  const params = new URLSearchParams({ start: localDay(from), days: String(days), pp: "100" });
  const data = (await getJson(`https://${host}/api/2/events?${params}`)) as { events?: Array<{ event: Record<string, unknown> }> };
  const out: CampusEvent[] = [];
  for (const { event: e } of data.events ?? []) {
    const instances = ((e.event_instances as Array<{ event_instance: { id: number; start: string; end: string | null } }>) ?? []).map(
      (x) => x.event_instance,
    );
    const inst = instances.find((i) => new Date(i.start) >= from) ?? instances[0];
    if (!inst) continue;
    const start = new Date(inst.start);
    const end = inst.end ? new Date(inst.end) : new Date(start.getTime() + 60 * 60_000);
    const summary = String(e.description_text ?? "").slice(0, 280);
    const tags = (e.tags as string[] | undefined) ?? [];
    out.push({
      id: `localist:${host}:${String(inst.id ?? e.id)}`,
      name: String(e.title ?? ""),
      org: String((e.departments as { name?: string } | undefined)?.name ?? ""),
      location: [e.location_name, e.room_number].filter(Boolean).join(" ") || "TBA",
      start: start.toISOString(),
      end: end.toISOString(),
      perks: FOOD_RE.test(`${e.title} ${summary}`) ? ["Free Food"] : [],
      categories: tags,
      summary,
      url: String(e.localist_url ?? `https://${host}`),
    });
  }
  return out;
}

// ---------- Any other events page (TinyFish Fetch + Claude) ----------

const PageEventsSchema = z.object({
  events: z.array(
    z.object({
      name: z.string(),
      start: z.string().describe("ISO 8601 with offset. Only events with an explicit date on the page."),
      end: z.string().describe("ISO 8601 with offset, or empty string if not stated"),
      location: z.string().describe("As written, or empty string"),
      link: z.string().describe("Absolute URL of the event's own page if linked, else empty string"),
      summary: z.string().describe("One sentence, or empty string"),
      free_food: z.boolean().describe("true only if the page says food/snacks/refreshments are provided"),
    }),
  ),
});

const pageCache = new Map<string, { textHash: string; events: CampusEvent[] }>();

export async function readEventsPage(url: string): Promise<CampusEvent[]> {
  const page = await fetchPage(url, { format: "markdown", ttl: 1800, purpose: "Find upcoming campus events with dates, times and locations" });
  const text = page.text.slice(0, 120_000);
  const textHash = createHash("sha1").update(text).digest("hex");
  const hit = pageCache.get(url);
  if (hit?.textHash === textHash) return hit.events;

  const tz = currentTimezone();
  const { events } = await extract(
    PageEventsSchema,
    `You extract upcoming events from a school's events web page. Today is ${localDay()} (timezone ${tz}).
Only include events with an explicit date on the page; never invent one. Times without a zone are local (${tz}).
If a time isn't stated, use 00:00 local and leave end empty. Resolve relative links against ${url}.`,
    `Page URL: ${url}\nPage title: ${page.title}\n\n${text}`,
    SITE_MODEL,
  );
  const out: CampusEvent[] = [];
  for (const e of events) {
    const start = new Date(e.start);
    if (Number.isNaN(start.getTime()) || !e.name.trim()) continue;
    const endRaw = e.end ? new Date(e.end) : null;
    const end = endRaw && !Number.isNaN(endRaw.getTime()) ? endRaw : new Date(start.getTime() + 60 * 60_000);
    const link = e.link || url;
    out.push({
      id: `page:${createHash("sha1").update(`${link}|${e.name}|${start.toISOString()}`).digest("hex").slice(0, 16)}`,
      name: e.name.trim(),
      org: "",
      location: e.location || "TBA",
      start: start.toISOString(),
      end: end.toISOString(),
      perks: e.free_food ? ["Free Food"] : [],
      categories: [],
      summary: e.summary,
      url: link,
    });
  }
  pageCache.set(url, { textHash, events: out });
  return out;
}

// ---------- Source detection ----------

async function probe(url: string, check: (j: unknown) => boolean): Promise<boolean> {
  try {
    const res = await fetch(url, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(10_000) });
    if (!res.ok || !(res.headers.get("content-type") ?? "").includes("json")) return false;
    return check(await res.json());
  } catch {
    return false;
  }
}

/**
 * Work out how to read a school's events link: Engage and Localist sites expose public
 * APIs on the same host; anything else becomes a page Scout reads with TinyFish Fetch.
 */
export async function detectEventSource(url: string): Promise<EventSource> {
  const u = new URL(url);
  const host = u.host;
  if (await probe(`https://${host}/api/discovery/event/search?take=1&status=Approved`, (j) => Array.isArray((j as { value?: unknown }).value))) {
    return { kind: "engage", host, label: host };
  }
  if (await probe(`https://${host}/api/2/events?pp=1`, (j) => Array.isArray((j as { events?: unknown }).events))) {
    return { kind: "localist", host, label: host };
  }
  return { kind: "page", url: u.href, label: host };
}

/** "find it": search for the school's events page. */
export async function findEventsPage(school: string): Promise<SearchResult[]> {
  const results = await search(`${school} student events calendar`, {
    purpose: `Find the page where ${school} posts campus and student organization events`,
  });
  return results.filter((r) => !/facebook|instagram|twitter|x\.com|reddit|eventbrite\.com\/d\//i.test(r.url)).slice(0, 3);
}

// ---------- Public API ----------

async function allEvents(source: EventSource, from: Date, to: Date): Promise<CampusEvent[]> {
  if (source.kind === "page") return readEventsPage(source.url);
  return source.kind === "engage" ? engageEvents(source.host, from) : localistEvents(source.host, from, to);
}

/** Upcoming events from the student's school, filtered by their interests. */
export async function getEvents(user: UserState, q: EventQuery = {}): Promise<CampusEvent[]> {
  if (!user.eventSource) return [];
  const from = q.from ?? new Date();
  const to = q.to ?? new Date(from.getTime() + 3 * 24 * 3600_000);
  const tz = currentTimezone();
  const kws = (q.keywords ?? []).map((k) => k.toLowerCase()).filter(Boolean);

  const events = (await allEvents(user.eventSource, from, to))
    .filter((e) => new Date(e.end) >= from && new Date(e.start) <= to)
    .sort((a, b) => a.start.localeCompare(b.start));
  rememberEvents(events);

  const out: CampusEvent[] = [];
  for (const ev of events) {
    if (q.eveningsOnly) {
      const hour = Number(new Date(ev.start).toLocaleString("en-US", { timeZone: tz, hour: "numeric", hourCycle: "h23" }));
      if (hour < 17) continue;
    }
    const hay = `${ev.name} ${ev.org} ${ev.categories.join(" ")} ${ev.perks.join(" ")} ${ev.summary}`.toLowerCase();
    const checks: boolean[] = [];
    if (q.freeFood) checks.push(ev.perks.includes("Free Food"));
    if (kws.length) checks.push(kws.some((k) => hay.includes(k)));
    if (checks.length && !(q.match === "any" ? checks.some(Boolean) : checks.every(Boolean))) continue;
    out.push(ev);
  }
  return out.slice(0, q.limit ?? 15);
}

/** An event shown earlier (for tapbacks and "add #2 to my calendar"), even after a restart. */
export async function getEventById(id: string): Promise<CampusEvent | undefined> {
  const hit = knownEvent(id);
  if (hit) return hit;
  const m = id.match(/^engage:([^:]+):(.+)$/);
  if (m) {
    const ev = await engageEventById(m[1]!, m[2]!);
    if (ev) rememberEvents([ev]);
    return ev;
  }
  return undefined;
}

/** Short name for the source, e.g. "gatorconnect.ufl.edu". */
export function eventSourceLabel(user: UserState): string {
  return user.eventSource?.label ?? "your school's events page";
}
