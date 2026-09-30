// Real web, free calls only:  npm run test:live
// TinyFish Search and Fetch are free; the Agent costs credits, so it only runs with LIVE_AGENT=1.
import "./guard.ts";
import assert from "node:assert/strict";
import test from "node:test";
import { buildBrief } from "../../src/brief.ts";
import { withTimezone } from "../../src/config.ts";
import { pickSubpages } from "../../src/sources/courseSites.ts";
import { detectEventSource, getEvents } from "../../src/sources/events.ts";
import { readJobBoard } from "../../src/sources/jobBoards.ts";
import { loadListings, verifyPosting } from "../../src/sources/jobs.ts";
import { newUser } from "../../src/store.ts";
import { fetchPage, search } from "../../src/tinyfish.ts";

test("TinyFish Search finds a school's events page", async () => {
  const results = await search("University of Florida student events calendar");
  assert.ok(results.length > 0);
  assert.ok(results.every((r) => /^https?:\/\//.test(r.url)));
});

test("TinyFish Fetch reads a course site with its links, and the crawler finds the deadline pages", async () => {
  const url = "https://www.cs.unc.edu/~stotts/COMP523-F26/";
  const page = await fetchPage(url, { links: true, ttl: 3600 });
  assert.ok(page.text.length > 200);
  const picked = pickSubpages(url, page.links);
  assert.ok(picked.some((u) => u.endsWith("calendar.html")), `picked: ${picked.join(", ")}`);
});

for (const [label, url, kind] of [
  ["Engage (University of Florida)", "https://gatorconnect.ufl.edu/events", "engage"],
  ["Localist (Stanford)", "https://events.stanford.edu/", "localist"],
] as const) {
  test(`events from ${label}`, async () => {
    const user = newUser("live");
    user.eventSource = await detectEventSource(url);
    assert.equal(user.eventSource.kind, kind);
    const events = await getEvents(user, { to: new Date(Date.now() + 14 * 24 * 3600_000), limit: 20 });
    assert.ok(events.length > 0, "found upcoming events");
    assert.ok(events.every((e) => e.url.startsWith("https://") && !Number.isNaN(Date.parse(e.start))));
  });
}

test("a Greenhouse careers page is read from its public API", async () => {
  const { jobs } = await readJobBoard("https://job-boards.greenhouse.io/duolingo");
  assert.ok(jobs.length > 0);
  assert.ok(jobs.every((j) => j.url.startsWith("https://") && j.company === "Duolingo"));
});

test("the Simplify tech-internship list loads", async () => {
  const listings = await loadListings();
  assert.ok(listings.length > 100);
  assert.ok(listings.every((j) => j.source === "simplify" && j.url));
});

test("the morning brief builds from real events (no Claude needed)", async () => {
  const user = newUser("brief");
  user.name = "Test";
  user.school = { name: "University of Florida", timezone: "America/New_York" };
  user.eventSource = await detectEventSource("https://gatorconnect.ufl.edu/events");
  user.internships.alerts = false;
  const brief = await withTimezone(user.school.timezone, () => buildBrief(user, { greeting: true }));
  assert.ok(brief && brief.length >= 1);
});

test("TinyFish Agent verifies a live posting (LIVE_AGENT=1, uses credits)", { skip: process.env.LIVE_AGENT !== "1" }, async () => {
  const { jobs } = await readJobBoard("https://job-boards.greenhouse.io/duolingo");
  const check = await verifyPosting(jobs[0]!.url);
  assert.ok(check.runId);
  assert.notEqual(check.accepting_applications, undefined);
});
