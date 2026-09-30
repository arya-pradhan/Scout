import "../setup.ts";
import assert from "node:assert/strict";
import test from "node:test";
import ical from "node-ical";
import { buildIcs, calendarReplies, deadlineItem, eventItem, googleCalendarUrl } from "../../src/calendar.ts";
import type { Assignment } from "../../src/sources/canvas.ts";
import type { CampusEvent } from "../../src/store.ts";

const deadline: Assignment = {
  key: "site:PSYC 210:ethics assignment due",
  course: "PSYC 210",
  title: "EOW: ethics assignment due",
  due: "2026-10-24T03:59:00.000Z", // Fri Oct 23, 11:59 PM Eastern
  url: "https://example.edu/psyc210/calendar.html",
  source: "course site",
};

const event: CampusEvent = {
  id: "engage:gatorconnect.ufl.edu:123",
  name: "Build Your CV",
  org: "Career Center",
  location: "Dickinson Hall 371",
  start: "2026-09-30T20:00:00.000Z",
  end: "2026-09-30T21:00:00.000Z",
  perks: ["Free Food"],
  categories: [],
  summary: "",
  url: "https://gatorconnect.ufl.edu/event/123",
};

test("a deadline becomes a 30-minute block ending at the due time, in UTC", () => {
  const params = new URL(googleCalendarUrl(deadlineItem(deadline))).searchParams;
  assert.equal(params.get("action"), "TEMPLATE");
  assert.equal(params.get("dates"), "20261024T032900Z/20261024T035900Z");
});

test("deadline titles drop 'EOW:' and a trailing 'due'", () => {
  assert.equal(deadlineItem(deadline).title, "DUE: PSYC 210 ethics assignment");
});

test("event links carry the location and the source link", () => {
  const params = new URL(googleCalendarUrl(eventItem(event))).searchParams;
  assert.equal(params.get("text"), "Build Your CV");
  assert.equal(params.get("location"), "Dickinson Hall 371");
  assert.match(params.get("details") ?? "", /gatorconnect\.ufl\.edu\/event\/123/);
});

test("calendarReplies is one bubble with at most 5 links, and notes default notifications for deadlines", () => {
  const items = Array.from({ length: 7 }, () => deadlineItem(deadline));
  const replies = calendarReplies(items);
  assert.equal(replies.length, 1);
  const text = "text" in replies[0]! ? replies[0].text : "";
  assert.equal(text.match(/calendar\.google\.com/g)?.length, 5);
  assert.match(text, /\+2 more/);
  assert.match(text, /default notifications/);
});

test("buildIcs output parses back with the same times", () => {
  const parsed = Object.values(ical.sync.parseICS(buildIcs([eventItem(event), deadlineItem(deadline)]))).filter((e) => e?.type === "VEVENT");
  assert.equal(parsed.length, 2);
  const starts = parsed.map((e) => new Date(e!.start as unknown as string).toISOString()).sort();
  assert.deepEqual(starts, ["2026-09-30T20:00:00.000Z", "2026-10-24T03:29:00.000Z"]);
});
