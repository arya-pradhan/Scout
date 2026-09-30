// Apple Calendar via .ics files. The bot never writes to anyone's calendar: it sends a
// calendar file in iMessage, and tapping it opens Apple's "Add to Calendar" sheet, so the
// student approves every add. Items are built only from real data (HeelLife, Canvas,
// course sites, the tracker), never from dates the model made up.

import { fmtDate } from "./config.ts";
import type { Reply } from "./reply.ts";
import type { Assignment } from "./sources/canvas.ts";
import type { CampusEvent } from "./sources/events.ts";

export interface CalItem {
  uid: string;
  title: string;
  start: Date;
  end: Date;
  location?: string;
  url?: string;
  description?: string;
  /** Alerts, in minutes before start. */
  alarms: number[];
}

const utc = (d: Date) => d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
const esc = (s: string) => s.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");

/** RFC 5545 line folding: lines longer than 75 octets continue on the next line after a space. */
function fold(line: string): string {
  const out: string[] = [];
  let cur = "";
  for (const ch of line) {
    if (Buffer.byteLength(cur + ch) > 74) {
      out.push(cur);
      cur = " " + ch;
    } else cur += ch;
  }
  out.push(cur);
  return out.join("\r\n");
}

export function buildIcs(items: CalItem[]): string {
  const now = utc(new Date());
  const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//iRameses//UNC student copilot//EN", "CALSCALE:GREGORIAN", "METHOD:PUBLISH"];
  for (const it of items) {
    lines.push(
      "BEGIN:VEVENT",
      `UID:${it.uid}@irameses`,
      `DTSTAMP:${now}`,
      `DTSTART:${utc(it.start)}`,
      `DTEND:${utc(it.end)}`,
      `SUMMARY:${esc(it.title)}`,
    );
    if (it.location) lines.push(`LOCATION:${esc(it.location)}`);
    if (it.url) lines.push(`URL:${it.url}`);
    const desc = [it.description, it.url].filter(Boolean).join("\n");
    if (desc) lines.push(`DESCRIPTION:${esc(desc)}`);
    for (const m of it.alarms) {
      lines.push("BEGIN:VALARM", "ACTION:DISPLAY", `DESCRIPTION:${esc(it.title)}`, `TRIGGER:-PT${m}M`, "END:VALARM");
    }
    lines.push("END:VEVENT");
  }
  lines.push("END:VCALENDAR");
  return lines.map(fold).join("\r\n") + "\r\n";
}

export function eventItem(e: CampusEvent): CalItem {
  return {
    uid: `heellife-${e.id}`,
    title: e.name,
    start: new Date(e.start),
    end: new Date(e.end),
    location: e.location,
    url: e.url,
    description: `${e.org}${e.perks.length ? ` · ${e.perks.join(", ")}` : ""}`,
    alarms: [30],
  };
}

/** A deadline becomes a 30-minute block ending at the due time, with alerts 1 day and 2 hours before. */
export function deadlineItem(a: Assignment): CalItem {
  const due = new Date(a.due);
  return {
    uid: `due-${Buffer.from(a.key).toString("base64url").slice(0, 40)}`,
    title: `DUE: ${a.course} ${a.title}`,
    start: new Date(due.getTime() - 30 * 60_000),
    end: due,
    url: a.url,
    description: `Due ${fmtDate(due)} (from ${a.source})`,
    alarms: [24 * 60 + 30, 150],
  };
}

/** The calendar file bubble, plus a one-line explanation. */
export function calendarReplies(items: CalItem[]): Reply[] {
  const what = items.length === 1 ? `"${items[0]!.title}"` : `${items.length} items`;
  return [
    { text: `📅 Tap to add ${what} to your calendar. Nothing gets added unless you hit Add.` },
    { file: { name: items.length === 1 ? "event.ics" : "events.ics", mimeType: "text/calendar", data: Buffer.from(buildIcs(items)) } },
  ];
}
