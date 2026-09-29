// Canvas homework via the student's private Calendar Feed (.ics). No login or SSO:
// the secret feed URL is read and parsed locally.

import ical from "node-ical";

export interface Assignment {
  key: string; // stable id for dedupe / "mark done"
  course: string;
  title: string;
  due: string; // ISO
  url: string;
  source: "canvas" | "course site" | "gradescope";
}

const FEED_RE = /^https:\/\/[\w.-]+\/feeds\/calendars\/user_[\w-]+\.ics$/i;

export function looksLikeCanvasFeed(url: string): boolean {
  return FEED_RE.test(url.trim());
}

/** Pull "COMP 211" out of "Lab 3 [COMP211.001.FA26]" or "COMP 211-001: Lab 3". */
export function courseCodeFrom(text: string): string | undefined {
  const m = text.match(/\b([A-Z]{3,4})\s?-?(\d{3}[A-Z]?)\b/);
  return m ? `${m[1]} ${m[2]}` : undefined;
}

// The feed is already structured calendar data, so it's read directly (TinyFish Fetch
// converts responses into readable text, which would lose the iCal fields).
async function fetchIcs(feedUrl: string): Promise<string> {
  const res = await fetch(feedUrl, { signal: AbortSignal.timeout(20_000) });
  const body = res.ok ? await res.text() : "";
  if (!body.includes("BEGIN:VCALENDAR")) {
    throw new Error(res.ok ? "That link didn't return a calendar feed" : `Canvas returned HTTP ${res.status}`);
  }
  return body;
}

export async function readCanvasFeed(feedUrl: string): Promise<Assignment[]> {
  const raw = await fetchIcs(feedUrl);
  const events = ical.sync.parseICS(raw);
  const out: Assignment[] = [];
  for (const ev of Object.values(events)) {
    if (!ev || ev.type !== "VEVENT" || !ev.start) continue;
    const summary = String(typeof ev.summary === "string" ? ev.summary : (ev.summary as { val?: string })?.val ?? "");
    const url = typeof ev.url === "string" ? ev.url : ((ev.url as { val?: string } | undefined)?.val ?? "");
    const location = typeof ev.location === "string" ? ev.location : "";
    // Canvas appends "[COURSE NAME]" to the summary.
    const bracket = summary.match(/\[([^\]]+)\]\s*$/)?.[1] ?? "";
    const course = courseCodeFrom(bracket) ?? courseCodeFrom(summary) ?? courseCodeFrom(location) ?? (bracket || "Canvas");
    out.push({
      key: `canvas:${ev.uid}`,
      course,
      title: summary.replace(/\s*\[[^\]]+\]\s*$/, "").trim(),
      due: new Date(ev.start).toISOString(),
      url: url || "https://canvas.unc.edu/calendar",
      source: "canvas",
    });
  }
  return out.sort((a, b) => a.due.localeCompare(b.due));
}
