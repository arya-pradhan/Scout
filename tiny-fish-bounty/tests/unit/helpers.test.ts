import "../setup.ts";
import assert from "node:assert/strict";
import test from "node:test";
import { fmtDate, localHour, normalizeSender, utcOffset, withTimezone } from "../../src/config.ts";
import { isQuiet } from "../../src/scheduler.ts";
import { courseCodeFrom, looksLikeCanvasFeed } from "../../src/sources/canvas.ts";
import { pickSubpages } from "../../src/sources/courseSites.ts";
import { newUser } from "../../src/store.ts";
import { plainText } from "../../src/text.ts";
import { agentSchema } from "../../src/tinyfish.ts";

test("agentSchema strips descriptions and turns type arrays into nullable", () => {
  const out = agentSchema({
    type: "object",
    properties: {
      open: { type: ["boolean", "null"], description: "x" },
      description: { type: "string" }, // a field *named* description is kept
      items: { type: "array", items: { type: "object", properties: { kind: { type: "string", description: "y" } } } },
    },
  });
  assert.deepEqual(out, {
    type: "object",
    properties: {
      open: { type: "boolean", nullable: true },
      description: { type: "string" },
      items: { type: "array", items: { type: "object", properties: { kind: { type: "string" } } } },
    },
  });
});

test("pickSubpages keeps same-folder deadline pages and skips other semesters and images", () => {
  const base = "https://www.example.edu/~prof/CS523-F26/";
  const links = [
    "http://www.example.edu/~prof/CS523-s26/weekmeet.html", // last semester's folder
    "https://www.example.edu/~prof/CS523-F26/syllabus.html",
    "https://www.example.edu/~prof/CS523-F26/calendar.html",
    "https://www.example.edu/~prof/CS523-F26/teams.html",
    "https://www.example.edu/~prof/CS523-F26/deliverables.html",
    "https://www.example.edu/~prof/CS523-F26/logo.png",
    "https://other-site.com/calendar.html",
  ];
  const picked = pickSubpages(base, links);
  assert.ok(picked.includes("https://www.example.edu/~prof/CS523-F26/calendar.html"));
  assert.ok(picked.includes("https://www.example.edu/~prof/CS523-F26/deliverables.html"));
  assert.ok(picked.includes("https://www.example.edu/~prof/CS523-F26/syllabus.html"));
  assert.ok(!picked.some((u) => /s26|png|other-site/.test(u)));
});

test("Canvas helpers", () => {
  assert.equal(courseCodeFrom("Lab 3 [BIO101.001.FA26]"), "BIO 101");
  assert.equal(courseCodeFrom("MATH 233-002: Quiz"), "MATH 233");
  assert.equal(courseCodeFrom("Office hours"), undefined);
  assert.ok(looksLikeCanvasFeed("https://ufl.instructure.com/feeds/calendars/user_abc123.ics"));
  assert.ok(!looksLikeCanvasFeed("https://ufl.instructure.com/courses/1"));
});

test("each student sees times in their school's timezone", () => {
  const due = "2026-10-24T03:59:00.000Z";
  assert.match(withTimezone("America/New_York", () => fmtDate(due)), /Fri, Oct 23, 11:59\s?PM/);
  assert.match(withTimezone("America/Los_Angeles", () => fmtDate(due)), /Fri, Oct 23, 8:59\s?PM/);
  assert.equal(withTimezone("America/Los_Angeles", () => utcOffset(new Date(due))), "-07:00");
  assert.equal(withTimezone("Asia/Tokyo", () => localHour(new Date(due))), 12);
});

test("quiet hours wrap around midnight", () => {
  const user = newUser("q");
  user.schedule = { briefHour: 8, quietStart: 23, quietEnd: 8 };
  assert.deepEqual([23, 2, 8, 12].map((h) => isQuiet(user, h)), [true, true, false, false]);
  user.schedule = { briefHour: 8, quietStart: 9, quietEnd: 9 };
  assert.equal(isQuiet(user, 3), false);
});

test("phone numbers normalize so the allowlist matches", () => {
  assert.equal(normalizeSender("(919) 555-1234"), "+19195551234");
  assert.equal(normalizeSender("+1 919 555 1234"), "+19195551234");
  assert.equal(normalizeSender("Student@Example.edu"), "student@example.edu");
});

test("plainText strips markdown that iMessage would show literally", () => {
  assert.equal(plainText("**Due soon**\n# Header\n- item\n[site](https://x.com)"), "Due soon\nHeader\n• item\nsite: https://x.com");
});
