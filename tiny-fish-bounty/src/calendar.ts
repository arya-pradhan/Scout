// Add-to-calendar. The bot never writes to anyone's calendar: it texts a Google Calendar
// "add event" link with the event filled in, and the student taps Save, so they approve
// every add. Items are built only from real data (school events, Canvas, course sites,
// the tracker), never from dates the model made up.
//
// (An .ics attachment was tried first, but iMessage on iPhone opens it in a read-only
// preview with no way to add it. buildIcs() is kept for a future Apple Calendar option
// that serves the file from a hosted https link, which Safari can add.)

import { fmtDate } from "./config.ts";
import type { Reply } from "./reply.ts";
import type { Assignment } from "./sources/canvas.ts";
import type { CampusEvent } from "./store.ts";

export interface CalItem {
  uid: string;
  title: string;
  start: Date;
  end: Date;
  location?: string;
  url?: string;
  description?: string;
  /** Alerts, in minutes before start (.ics only; Google links use the student's default notifications). */
  alarms: number[];
  /** Set for deadlines: the actual due time (the event itself is a short block ending here). */
  due?: Date;
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

/** .ics text for the items. Currently unused (see the note at the top of this file). */
export function buildIcs(items: CalItem[]): string {
  const now = utc(new Date());
  const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Scout//Student copilot//EN", "CALSCALE:GREGORIAN", "METHOD:PUBLISH"];
  for (const it of items) {
    lines.push(
      "BEGIN:VEVENT",
      `UID:${it.uid}@scout`,
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
    uid: `event-${e.id.replace(/[^A-Za-z0-9.-]/g, "-")}`,
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
  // Course sites often title items "EOW: ethics assignment due"; the calendar title already says DUE.
  const name = a.title.replace(/^\s*EOW:\s*/i, "").replace(/\s+due\s*$/i, "").trim() || a.title;
  return {
    uid: `due-${Buffer.from(a.key).toString("base64url").slice(0, 40)}`,
    title: `DUE: ${a.course} ${name}`,
    due,
    start: new Date(due.getTime() - 30 * 60_000),
    end: due,
    url: a.url,
    description: `Due ${fmtDate(due)} (from ${a.source})`,
    alarms: [24 * 60 + 30, 150],
  };
}

/**
 * Google Calendar "add event" link: opens Google Calendar (app or web) with the event
 * filled in; nothing is saved until the student taps Save. No API key or sign-in flow needed.
 */
export function googleCalendarUrl(item: CalItem): string {
  const details = [item.description, item.url].filter(Boolean).join("\n").slice(0, 800);
  const params = new URLSearchParams({ action: "TEMPLATE", text: item.title, dates: `${utc(item.start)}/${utc(item.end)}` });
  if (details) params.set("details", details);
  if (item.location) params.set("location", item.location);
  return `https://calendar.google.com/calendar/render?${params}`;
}

const MAX_LINKS = 5;

/** One bubble with a Google Calendar link per item. */
export function calendarReplies(items: CalItem[]): Reply[] {
  const shown = items.slice(0, MAX_LINKS);
  const lines = shown.map((it) => {
    const when = it.due ? `due ${fmtDate(it.due)}` : fmtDate(it.start);
    return `${it.title} (${when})\n${googleCalendarUrl(it)}`;
  });
  const head = shown.length === 1 ? "📅 Tap to add it to Google Calendar, then hit Save:" : "📅 Tap each to add it to Google Calendar, then hit Save:";
  const more = items.length > MAX_LINKS ? `\n\n(+${items.length - MAX_LINKS} more, ask me to add the rest)` : "";
  const note = shown.some((it) => it.due) ? "\n\nGoogle will use your default notifications for these." : "";
  return [{ text: `${head}\n\n${lines.join("\n\n")}${more}${note}` }];
}
