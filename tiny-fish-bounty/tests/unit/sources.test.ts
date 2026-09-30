import { json, mockFetch, resetFetch } from "../setup.ts";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { detectEventSource, getEventById, getEvents } from "../../src/sources/events.ts";
import { readJobBoard } from "../../src/sources/jobBoards.ts";
import { matchesPrefs, type Job } from "../../src/sources/jobs.ts";
import { newUser } from "../../src/store.ts";

afterEach(resetFetch);

const soon = (h: number) => new Date(Date.now() + h * 3600_000).toISOString();

const engageSearch = {
  value: [
    { id: 1, name: "Career Fair", organizationName: "Career Center", location: "Union", startsOn: soon(2), endsOn: soon(4), benefitNames: [], description: "<p>Meet employers</p>" },
    { id: 2, name: "Pizza Night", organizationName: "Chess Club", location: "Library", startsOn: soon(20), endsOn: soon(22), benefitNames: ["Free Food"], description: "" },
    { id: 3, name: "Yoga", organizationName: "Rec", location: "Gym", startsOn: soon(200), endsOn: soon(201), benefitNames: [], description: "" },
  ],
};

test("detectEventSource recognizes Engage, Localist, and falls back to page mode", async () => {
  mockFetch((url) => {
    if (url.startsWith("https://orgs.school-a.edu/api/discovery/event/search")) return json({ value: [] });
    if (url.startsWith("https://events.school-b.edu/api/2/events")) return json({ events: [] });
    if (url.includes("/api/")) return new Response("not found", { status: 404 });
    return undefined;
  });
  assert.deepEqual(await detectEventSource("https://orgs.school-a.edu/events"), { kind: "engage", host: "orgs.school-a.edu", label: "orgs.school-a.edu" });
  assert.deepEqual(await detectEventSource("https://events.school-b.edu/"), { kind: "localist", host: "events.school-b.edu", label: "events.school-b.edu" });
  assert.equal((await detectEventSource("https://www.school-c.edu/calendar")).kind, "page");
});

test("Engage events: window, free-food and keyword filters, and ids that work later", async () => {
  mockFetch((url) => (url.includes("/api/discovery/event/search") ? json(engageSearch) : undefined));
  const user = newUser("e");
  user.eventSource = { kind: "engage", host: "orgs.school-a.edu", label: "orgs.school-a.edu" };

  const all = await getEvents(user, { to: new Date(Date.now() + 3 * 24 * 3600_000) });
  assert.deepEqual(all.map((e) => e.name), ["Career Fair", "Pizza Night"]); // Yoga is outside the window
  assert.equal(all[0]!.url, "https://orgs.school-a.edu/event/1");

  const food = await getEvents(user, { freeFood: true });
  assert.deepEqual(food.map((e) => e.name), ["Pizza Night"]);

  const either = await getEvents(user, { freeFood: true, keywords: ["career"], match: "any" });
  assert.deepEqual(either.map((e) => e.name), ["Career Fair", "Pizza Night"]);

  // Shown events are remembered, so a ❤️ tapback after a restart still finds them (no network).
  resetFetch();
  assert.equal((await getEventById(all[0]!.id))?.name, "Career Fair");
});

test("Localist events map title, venue, link and detect free food from the text", async () => {
  mockFetch((url) =>
    url.startsWith("https://events.school-b.edu/api/2/events")
      ? json({
          events: [
            {
              event: {
                id: 9,
                title: "Study Break",
                location_name: "Green Library",
                room_number: "101",
                localist_url: "https://events.school-b.edu/event/study-break",
                description_text: "Free pizza and snacks provided!",
                departments: { name: "Libraries" },
                tags: ["social"],
                event_instances: [{ event_instance: { id: 99, start: soon(3), end: soon(4) } }],
              },
            },
          ],
        })
      : undefined,
  );
  const user = newUser("l");
  user.eventSource = { kind: "localist", host: "events.school-b.edu", label: "events.school-b.edu" };
  const [ev] = await getEvents(user, { freeFood: true });
  assert.equal(ev?.name, "Study Break");
  assert.equal(ev?.location, "Green Library 101");
  assert.equal(ev?.url, "https://events.school-b.edu/event/study-break");
  assert.deepEqual(ev?.perks, ["Free Food"]);
});

test("no events source means no events (and no network)", async () => {
  assert.deepEqual(await getEvents(newUser("none")), []);
});

test("Greenhouse and Lever careers pages are read from their public JSON", async () => {
  mockFetch((url) => {
    if (url === "https://boards-api.greenhouse.io/v1/boards/acme") return json({ name: "Acme" });
    if (url === "https://boards-api.greenhouse.io/v1/boards/acme/jobs") {
      return json({
        jobs: [
          { title: "Marketing Intern", absolute_url: "https://acme.com/jobs/1", location: { name: "Chicago, IL" }, first_published: "2026-09-20T12:00:00Z" },
          { title: "Staff Engineer", absolute_url: "https://acme.com/jobs/2", location: { name: "Remote" } },
        ],
      });
    }
    if (url.startsWith("https://api.lever.co/v0/postings/beta")) {
      return json([{ text: "Brand Intern", hostedUrl: "https://jobs.lever.co/beta/1", categories: { location: "NYC" }, createdAt: 1790000000000 }]);
    }
    return undefined;
  });
  const gh = await readJobBoard("https://job-boards.greenhouse.io/acme");
  assert.deepEqual(gh.jobs.map((j) => [j.company, j.title, j.locations[0], j.url]), [
    ["Acme", "Marketing Intern", "Chicago, IL", "https://acme.com/jobs/1"],
    ["Acme", "Staff Engineer", "Remote", "https://acme.com/jobs/2"],
  ]);
  assert.equal(gh.jobs[0]!.postedAt, "2026-09-20T12:00:00.000Z");
  const lever = await readJobBoard("https://jobs.lever.co/beta");
  assert.equal(lever.jobs[0]!.title, "Brand Intern");
});

test("matchesPrefs: Simplify roles, board keywords/internship-only, locations, muted companies", () => {
  const prefs = {
    ...newUser("p").internships,
    roles: ["Software"],
    keywords: ["marketing"],
    internshipOnly: true,
    locations: ["Chicago"],
    remoteOk: true,
  };
  const job = (over: Partial<Job>): Job => ({
    id: "x",
    company: "Acme",
    title: "Marketing Intern",
    category: "",
    locations: ["Chicago, IL"],
    sponsorship: "",
    url: "https://acme.com/1",
    postedAt: new Date().toISOString(),
    source: "board",
    ...over,
  });
  assert.equal(matchesPrefs(job({}), prefs), true);
  assert.equal(matchesPrefs(job({ title: "Marketing Manager" }), prefs), false, "board: internships only");
  assert.equal(matchesPrefs(job({ title: "Engineering Intern" }), prefs), false, "board: title keyword");
  assert.equal(matchesPrefs(job({ locations: ["Remote"] }), prefs), true, "remote is ok");
  assert.equal(matchesPrefs(job({ locations: ["Boston, MA"] }), prefs), false, "wrong city");
  assert.equal(matchesPrefs(job({ locations: [] }), prefs), true, "unknown location is kept");
  assert.equal(matchesPrefs(job({ source: "simplify", category: "Software", title: "SWE Intern" }), prefs), true, "Simplify uses roles, not keywords");
  assert.equal(matchesPrefs(job({ source: "simplify", category: "Hardware", title: "HW Intern" }), prefs), false);
  assert.equal(matchesPrefs(job({}), { ...prefs, excludeCompanies: ["acme"] }), false, "muted with 👎");
});
