// Campus events from HeelLife (Campus Labs Engage). The /events page is a JS app, but
// it's backed by a public JSON search API that we read directly: it's already structured
// data, and TinyFish Fetch converts responses to readable text, which loses the records.
// (Claude can still open any event page with the read_page tool, which uses TinyFish Fetch.)

import { TIMEZONE } from "../config.ts";

const API = "https://heellife.unc.edu/api/discovery/event/search";

export interface CampusEvent {
  id: string;
  name: string;
  org: string;
  location: string;
  start: string;
  end: string;
  perks: string[];
  categories: string[];
  summary: string;
  url: string;
}

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

function stripHtml(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&[a-z#0-9]+;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

type EventData = { value?: Array<Record<string, unknown>> };

// 10-minute cache: events don't change minute to minute, and the window is rounded so it hits.
const cache = new Map<string, { at: number; data: EventData }>();

async function fetchEventData(url: string): Promise<EventData> {
  const key = url;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < 10 * 60_000) return hit.data;
  const res = await fetch(url, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`HeelLife returned HTTP ${res.status}`);
  const data = (await res.json()) as EventData;
  cache.set(key, { at: Date.now(), data });
  return data;
}

export async function getEvents(q: EventQuery = {}): Promise<CampusEvent[]> {
  const from = q.from ?? new Date();
  const to = q.to ?? new Date(from.getTime() + 3 * 24 * 3600_000);
  // Round the window start down to 10 minutes so repeat questions hit the cache.
  const roundedFrom = new Date(Math.floor(from.getTime() / 600_000) * 600_000);
  const params = new URLSearchParams({
    endsAfter: roundedFrom.toISOString(),
    orderByField: "endsOn",
    orderByDirection: "ascending",
    status: "Approved",
    take: "100",
    query: "",
  });
  const data = await fetchEventData(`${API}?${params}`);

  const kws = (q.keywords ?? []).map((k) => k.toLowerCase()).filter(Boolean);
  const events: CampusEvent[] = [];
  for (const e of data.value ?? []) {
    const start = new Date(String(e.startsOn));
    if (start > to) continue;
    const ev: CampusEvent = {
      id: String(e.id),
      name: String(e.name ?? ""),
      org: String(e.organizationName ?? ""),
      location: String(e.location ?? "TBA"),
      start: start.toISOString(),
      end: new Date(String(e.endsOn)).toISOString(),
      perks: (e.benefitNames as string[] | undefined) ?? [],
      categories: (e.categoryNames as string[] | undefined) ?? [],
      summary: stripHtml(String(e.description ?? "")).slice(0, 280),
      url: `https://heellife.unc.edu/event/${String(e.id)}`,
    };
    if (q.eveningsOnly) {
      const hour = Number(start.toLocaleString("en-US", { timeZone: TIMEZONE, hour: "numeric", hourCycle: "h23" }));
      if (hour < 17) continue;
    }
    const hay = `${ev.name} ${ev.org} ${ev.categories.join(" ")} ${ev.perks.join(" ")} ${ev.summary}`.toLowerCase();
    const checks: boolean[] = [];
    if (q.freeFood) checks.push(ev.perks.includes("Free Food"));
    if (kws.length) checks.push(kws.some((k) => hay.includes(k)));
    if (checks.length && !(q.match === "any" ? checks.some(Boolean) : checks.every(Boolean))) continue;
    events.push(ev);
  }
  return events.slice(0, q.limit ?? 15);
}
