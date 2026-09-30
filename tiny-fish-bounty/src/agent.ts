// The chat brain: every text after onboarding goes through Claude with tools that
// do the real web work via TinyFish. Claude decides which tools to call and writes
// the reply; it may only state facts that came back from a tool.

import type Anthropic from "@anthropic-ai/sdk";
import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";
import { calendarFor, markDone } from "./actions.ts";
import { findApplication, prepApplication, prepSummary, saveApplication, setStatus, trackerSummary } from "./applications.ts";
import type { CalItem } from "./calendar.ts";
import { fmtDate, MODEL, MODEL_SUPPORTS_EFFORT, MODEL_SUPPORTS_FALLBACKS, TIMEZONE } from "./config.ts";
import { clearHomeworkCache, upcomingHomework } from "./homework.ts";
import { claude } from "./llm.ts";
import { profileSummary } from "./onboarding.ts";
import { say, type Effect, type Reply } from "./reply.ts";
import { readCourseSiteDeep, upsertSite } from "./sources/courseSites.ts";
import { getEvents } from "./sources/events.ts";
import { loadListings, matchesPrefs, verifyPosting } from "./sources/internships.ts";
import { save, shortId, type MessageRef, type UserState } from "./store.ts";
import { fetchPage, search } from "./tinyfish.ts";

const SYSTEM = `You are iRameses, an assistant a UNC Chapel Hill student texts over iMessage. You help with homework deadlines (Canvas + professor course sites), internships (the Simplify Summer 2027 list, plus the student's own application tracker), campus events (HeelLife), reminders, and research on the live web.

How to write:
- This is a text thread. Plain text only: iMessage does not render markdown, so no asterisks, no # headings, no tables.
- Be brief and warm, like a helpful friend who texts back fast. Usually 1-6 lines.
- For lists, use "• " bullets, at most 4 items, then offer to send more. Put each item's link on the line below it.
- 0-2 emoji per message, only when natural.

Trust rules (these matter more than anything else):
- Deadlines, events, postings, and anything that changes must come from a tool result in this conversation. Never answer those from memory.
- Never invent a date, link, company detail, or source. If a tool failed, say which source failed and share what did work.
- If the tools don't have the answer, say so plainly and offer to look it up.
- For general questions (what a company's internship is like, what a club does, how to do something), use search_web, then read_page on the 1-2 best results, and cite the links you used.
- You only read the web. You never submit assignments, RSVP, apply, fill in forms, email, or buy anything. If asked, say so and give the link so the student can do it.
- Application essays: after prep_application, you may offer to draft answers, but only write drafts when the student says yes. Drafts are text for them to edit and paste themselves.
- Calendar: you can't write to their calendar. add_to_calendar sends a calendar file they tap to add (they approve it with "Add"). Offer it after listing events or deadlines, but only call it once they say yes or name the items. After calling it, reply with one short line at most.
- Never repeat the student's Canvas feed link.

Tool tips:
- check_posting and prep_application open real pages in a browser and take about a minute. Use them when the student asks, not for every listing.
- "done with X" / "turned in X" → mark_done. "I applied to X" / "got an interview" / "got an offer" / "rejected" → update_application (save it first if it isn't tracked).
- "remind me…" → set_reminder. "snooze" / "remind me later" about something you just sent → set_reminder with that content; if no time is given, use 2 hours from now and say so.
- Requests to change their setup (courses, course sites, brief time, alert preferences) → update_settings.
- The student can tap-back your texts: 👍 marks homework done or completes a reminder, ❤️ saves internships or adds events/deadlines to their calendar, 👎 hides a company, ❓ asks you to explain. Mention this only if they ask how.
- When the student shares a lasting preference or fact about themselves, save it with remember.`;

interface ToolContext {
  user: UserState;
  /** Send an interim text (e.g. "checking the live posting…") while a slow tool runs. */
  notify: (text: string) => Promise<void>;
  /** Bubbles to send after Claude's reply (calendar files, confetti). */
  extras: Reply[];
  effect?: Effect;
  /** What tools listed this turn, so a tapback on the reply can act on the items it mentions. */
  listed: { events: Map<string, string>; jobs: Map<string, string>; assignments: Map<string, string> };
  /** Web pages read this turn (read_page), cited automatically if the reply forgets to. */
  pagesRead: Set<string>;
}

/** Tool results go back to Claude as JSON; errors become a readable message instead of crashing the turn. */
async function safe(name: string, fn: () => Promise<unknown>): Promise<string> {
  try {
    return JSON.stringify(await fn());
  } catch (err) {
    console.warn(`[tool ${name}]`, err);
    return JSON.stringify({ error: `${name} failed: ${(err as Error).message}` });
  }
}

function buildTools(ctx: ToolContext) {
  const { user } = ctx;
  return [
    betaZodTool({
      name: "get_homework",
      description:
        "Upcoming homework, projects and exams from the student's Canvas feed and saved course sites, soonest first. Excludes items marked done.",
      inputSchema: z.object({
        days_ahead: z.number().int().min(1).max(60).describe("How many days ahead to look. 1 = today/tonight, 7 = this week."),
        refresh: z.boolean().optional().describe("true to bypass the 15-minute cache"),
      }),
      run: (input) =>
        safe("get_homework", async () => {
          if (!user.canvasIcs && !user.courses.some((c) => c.sites.length)) {
            return { error: "No homework sources set up yet. The student can text 'settings' or send their Canvas calendar feed link." };
          }
          const { items, failed } = await upcomingHomework(user, input.days_ahead, input.refresh ?? false);
          for (const a of items) ctx.listed.assignments.set(a.key, a.title);
          return {
            now: fmtDate(new Date()),
            items: items.map((a) => ({ id: a.key, course: a.course, title: a.title, due: fmtDate(a.due), url: a.url, source: a.source })),
            failed_sources: failed,
          };
        }),
    }),

    betaZodTool({
      name: "mark_done",
      description: "Mark assignments as finished so they stop showing up in lists and reminders.",
      inputSchema: z.object({ titles: z.array(z.string()).describe("Assignment titles (or distinctive parts of them)") }),
      run: (input) =>
        safe("mark_done", async () => {
          const { items } = await upcomingHomework(user, 60, false, true);
          const keys: string[] = [];
          const alreadyDone: string[] = [];
          const notFound: string[] = [];
          for (const t of input.titles) {
            const hit = items.find((a) => `${a.course} ${a.title}`.toLowerCase().includes(t.toLowerCase()));
            if (!hit) notFound.push(t);
            else if (user.doneAssignments.includes(hit.key)) alreadyDone.push(`${hit.course}: ${hit.title}`);
            else keys.push(hit.key);
          }
          const { marked, replies } = await markDone(user, keys);
          ctx.extras.push(...replies);
          return { marked, already_done: alreadyDone, not_found: notFound, week_is_clear: replies.length > 0 };
        }),
    }),

    betaZodTool({
      name: "get_events",
      description: "Upcoming UNC campus events from HeelLife, with time, place, perks (e.g. Free Food) and link.",
      inputSchema: z.object({
        from_iso: z.string().optional().describe("Start of window, ISO 8601 with offset. Default: now."),
        to_iso: z.string().optional().describe("End of window, ISO 8601 with offset. Default: 3 days from now."),
        keywords: z.array(z.string()).optional().describe("Match any of these in name/org/description. Omit to use no keyword filter."),
        free_food: z.boolean().optional(),
        match: z.enum(["all", "any"]).optional().describe('With both keywords and free_food: "all" = both must match (default), "any" = either'),
        evenings_only: z.boolean().optional(),
      }),
      run: (input) =>
        safe("get_events", async () => {
          const events = await getEvents({
            from: input.from_iso ? new Date(input.from_iso) : undefined,
            to: input.to_iso ? new Date(input.to_iso) : undefined,
            keywords: input.keywords,
            freeFood: input.free_food,
            match: input.match,
            eveningsOnly: input.evenings_only,
            limit: 10,
          });
          for (const e of events) ctx.listed.events.set(e.id, e.url);
          return events.map((e) => ({
            id: e.id,
            name: e.name,
            when: fmtDate(e.start),
            where: e.location,
            org: e.org,
            perks: e.perks,
            about: e.summary.slice(0, 160),
            url: e.url,
          }));
        }),
    }),

    betaZodTool({
      name: "get_internships",
      description:
        "Open Summer 2027 internships from the Simplify list (updated daily), newest first. Listings are not verified live; use check_posting for that.",
      inputSchema: z.object({
        query: z.string().optional().describe("Words that must all appear in company/title/category, e.g. 'google' or 'data science'"),
        posted_within_days: z.number().int().min(1).max(365).optional(),
        use_my_preferences: z.boolean().describe("Filter by the student's saved role/location/sponsorship preferences"),
        limit: z.number().int().min(1).max(15).optional(),
      }),
      run: (input) =>
        safe("get_internships", async () => {
          const all = await loadListings();
          const since = input.posted_within_days ? Date.now() - input.posted_within_days * 24 * 3600_000 : 0;
          const noPrefs = { ...user.internships, roles: [], locations: [], needsSponsorship: false };
          const jobs = all
            .filter((j) => new Date(j.postedAt).getTime() >= since)
            .filter((j) => matchesPrefs(j, input.use_my_preferences ? user.internships : noPrefs, input.query))
            .slice(0, input.limit ?? 6);
          for (const j of jobs) ctx.listed.jobs.set(j.id, j.url);
          return jobs.map((j) => ({
            id: j.id,
            company: j.company,
            title: j.title,
            category: j.category,
            locations: j.locations.slice(0, 3),
            sponsorship: j.sponsorship,
            posted: fmtDate(j.postedAt),
            url: j.url,
          }));
        }),
    }),

    betaZodTool({
      name: "check_posting",
      description:
        "Open a job posting in a real browser (TinyFish Agent) and report whether it is still accepting applications, the deadline, pay, and key requirements. Takes ~1 minute. Never applies.",
      inputSchema: z.object({ url: z.string().describe("The posting URL from get_internships"), company: z.string() }),
      run: (input) =>
        safe("check_posting", async () => {
          await ctx.notify(`Opening the live ${input.company} posting to check… (~1 min) 🔎`);
          return await verifyPosting(input.url);
        }),
    }),

    betaZodTool({
      name: "save_application",
      description: "Add an internship to the student's application tracker (status 'saved').",
      inputSchema: z.object({ company: z.string(), title: z.string(), url: z.string().describe("Posting URL from get_internships or the student") }),
      run: (input) =>
        safe("save_application", async () => {
          const listing = (await loadListings()).find((j) => j.url === input.url);
          const { app, isNew } = saveApplication(user, { ...input, listingId: listing?.id });
          return { id: app.id, status: app.status, already_tracked: !isNew };
        }),
    }),

    betaZodTool({
      name: "update_application",
      description: "Change a tracked application's status.",
      inputSchema: z.object({
        company_or_id: z.string(),
        status: z.enum(["saved", "applied", "interviewing", "offer", "rejected", "closed"]),
      }),
      run: (input) =>
        safe("update_application", async () => {
          const app = findApplication(user, input.company_or_id);
          if (!app) return { error: `No tracked application matches "${input.company_or_id}". Save it first with save_application.` };
          setStatus(user, app, input.status);
          if (input.status === "offer") ctx.extras.push(say(`🎆 An offer from ${app.company}!! So proud of you.`, undefined, "fireworks"));
          return { id: app.id, company: app.company, status: app.status };
        }),
    }),

    betaZodTool({
      name: "list_applications",
      description: "The student's application tracker with statuses and any prep results.",
      inputSchema: z.object({}),
      run: () =>
        safe("list_applications", async () =>
          user.applications.map((a) => ({
            id: a.id,
            company: a.company,
            title: a.title,
            status: a.status,
            saved: fmtDate(a.savedAt),
            applied: a.appliedAt ? fmtDate(a.appliedAt) : null,
            deadline: a.prep?.deadline || null,
            prepped: !!a.prep,
            url: a.url,
          })),
        ),
    }),

    betaZodTool({
      name: "prep_application",
      description:
        "Open the real application form in a browser (TinyFish Agent) and list its questions, required documents and deadline. Read-only: never fills in or submits anything. Takes ~1-2 minutes. Saves the job to the tracker if needed.",
      inputSchema: z.object({
        company_or_id: z.string().optional().describe("A tracked application"),
        url: z.string().optional().describe("Posting URL, if it isn't tracked yet"),
        company: z.string().optional(),
        title: z.string().optional(),
      }),
      run: (input) =>
        safe("prep_application", async () => {
          let app = input.company_or_id ? findApplication(user, input.company_or_id) : undefined;
          if (!app && input.url) app = saveApplication(user, { company: input.company ?? "Unknown", title: input.title ?? "Internship", url: input.url }).app;
          if (!app) return { error: "Need a tracked application or a posting URL." };
          await ctx.notify(`Opening the ${app.company} application to see what it asks… (~1-2 min) 📝`);
          const prep = await prepApplication(app.url);
          app.prep = prep;
          save();
          return { summary_for_student: prepSummary(app, prep), ...prep };
        }),
    }),

    betaZodTool({
      name: "set_reminder",
      description: "Text the student a reminder at an exact time. Also used for 'snooze'.",
      inputSchema: z.object({
        text: z.string().describe("What to remind them about, short"),
        at_iso: z.string().describe("When, ISO 8601 with offset, computed from 'Right now' in your context"),
      }),
      run: (input) =>
        safe("set_reminder", async () => {
          const at = new Date(input.at_iso).getTime();
          if (Number.isNaN(at)) return { error: "Couldn't understand that time." };
          if (at < Date.now() - 60_000) return { error: "That time is in the past." };
          const r = { id: shortId(), text: input.text, at, createdAt: Date.now() };
          user.reminders.push(r);
          save();
          return { id: r.id, when: fmtDate(at) };
        }),
    }),

    betaZodTool({
      name: "list_reminders",
      description: "Upcoming reminders the student has set.",
      inputSchema: z.object({}),
      run: () =>
        safe("list_reminders", async () =>
          user.reminders.filter((r) => !r.sentAt && !r.done).map((r) => ({ id: r.id, text: r.text, when: fmtDate(r.at) })),
        ),
    }),

    betaZodTool({
      name: "cancel_reminder",
      description: "Cancel a reminder by id or by words in its text.",
      inputSchema: z.object({ id_or_text: z.string() }),
      run: (input) =>
        safe("cancel_reminder", async () => {
          const q = input.id_or_text.toLowerCase();
          const r = user.reminders.find((x) => !x.done && (x.id === input.id_or_text || x.text.toLowerCase().includes(q)));
          if (!r) return { error: "No matching reminder." };
          r.done = true;
          save();
          return { cancelled: r.text };
        }),
    }),

    betaZodTool({
      name: "add_to_calendar",
      description:
        "Send a calendar file the student taps to add to Apple Calendar (they approve with 'Add'). Build it from ids returned by get_events / get_homework, or custom items with times the student gave you. Only call after the student asked or said yes.",
      inputSchema: z.object({
        event_ids: z.array(z.string()).optional().describe("HeelLife event ids from get_events"),
        assignment_ids: z.array(z.string()).optional().describe("Homework ids from get_homework"),
        assignment_titles: z
          .array(z.string())
          .optional()
          .describe("Or name assignments (e.g. 'ethics assignment'); matched against everything due in the next 60 days"),
        custom: z
          .array(
            z.object({
              title: z.string(),
              start_iso: z.string(),
              end_iso: z.string().optional(),
              location: z.string().optional(),
            }),
          )
          .optional()
          .describe("Only for times the student told you (e.g. their interview)"),
      }),
      run: (input) =>
        safe("add_to_calendar", async () => {
          const custom: CalItem[] = [];
          for (const c of input.custom ?? []) {
            const start = new Date(c.start_iso);
            if (Number.isNaN(start.getTime())) continue;
            const end = c.end_iso ? new Date(c.end_iso) : new Date(start.getTime() + 60 * 60_000);
            custom.push({ uid: `custom-${shortId()}`, title: c.title, start, end, location: c.location, alarms: [30] });
          }
          const assignmentKeys = [...(input.assignment_ids ?? [])];
          if (input.assignment_titles?.length) {
            const { items } = await upcomingHomework(user, 60);
            for (const t of input.assignment_titles) {
              const hit = items.find((a) => `${a.course} ${a.title}`.toLowerCase().includes(t.toLowerCase()));
              if (hit) assignmentKeys.push(hit.key);
            }
          }
          const { replies, added, missing } = await calendarFor(user, { events: input.event_ids, assignments: assignmentKeys, custom });
          ctx.extras.push(...replies);
          return { sent_calendar_file_with: added, not_found: missing, note: "The student still has to tap Add. Keep your reply to one short line." };
        }),
    }),

    betaZodTool({
      name: "search_web",
      description: "Search the live web (TinyFish Search). Returns titles, URLs and snippets.",
      inputSchema: z.object({
        query: z.string(),
        domains: z.array(z.string()).optional().describe("Restrict to these domains, e.g. ['unc.edu']"),
      }),
      run: (input) =>
        safe("search_web", async () =>
          (await search(input.query, { includeDomains: input.domains, purpose: `Answer a UNC student's question: ${input.query}` })).slice(0, 6),
        ),
    }),

    betaZodTool({
      name: "read_page",
      description: "Read a web page (TinyFish Fetch, renders JavaScript) and return its text as markdown.",
      inputSchema: z.object({ url: z.string(), question: z.string().describe("What you're looking for on the page") }),
      run: (input) =>
        safe("read_page", async () => {
          const page = await fetchPage(input.url, { format: "markdown", ttl: 3600, purpose: input.question });
          ctx.pagesRead.add(page.url || input.url);
          return { url: page.url || input.url, title: page.title, text: page.text.slice(0, 25_000) };
        }),
    }),

    betaZodTool({
      name: "update_settings",
      description: "Change the student's setup. Only include fields they asked to change.",
      inputSchema: z.object({
        add_course: z.string().optional().describe('Course code like "COMP 455"'),
        remove_course: z.string().optional(),
        add_course_site: z
          .object({ course: z.string(), url: z.string() })
          .optional()
          .describe("Also use this to re-scan a site that's already saved (e.g. when deadlines are missing)"),
        remove_course_site: z.object({ course: z.string(), url: z.string() }).optional(),
        brief_hour: z.number().int().min(0).max(23).optional(),
        quiet_start: z.number().int().min(0).max(23).optional(),
        quiet_end: z.number().int().min(0).max(23).optional(),
        internship_alerts: z.boolean().optional(),
        internship_roles: z.array(z.enum(["Software", "AI/ML/Data", "Quant", "Product", "Hardware"])).optional(),
        internship_locations: z.array(z.string()).optional(),
        needs_sponsorship: z.boolean().optional(),
        unmute_companies: z.array(z.string()).optional().describe("Companies to show again after a 👎"),
        event_keywords: z.array(z.string()).optional(),
        free_food: z.boolean().optional(),
        evenings_only: z.boolean().optional(),
      }),
      run: (input) =>
        safe("update_settings", async () => {
          const notes: string[] = [];
          const findCourse = (code: string) =>
            user.courses.find((c) => c.code.replace(/\s/g, "").toLowerCase() === code.replace(/\s/g, "").toLowerCase());
          if (input.add_course && !findCourse(input.add_course)) {
            user.courses.push({ code: input.add_course.toUpperCase(), sites: [] });
            notes.push(`added ${input.add_course}`);
          }
          if (input.remove_course) {
            user.courses = user.courses.filter((c) => c !== findCourse(input.remove_course!));
            notes.push(`removed ${input.remove_course}`);
          }
          if (input.add_course_site) {
            const { course: code, url } = input.add_course_site;
            let course = findCourse(code);
            if (!course) {
              course = { code: code.toUpperCase(), sites: [] };
              user.courses.push(course);
            }
            const read = await readCourseSiteDeep(url, course.code, () =>
              ctx.notify(`Digging through the ${course!.code} site for deadlines… (~1 min) 🔎`),
            );
            upsertSite(course, url, read);
            const upcoming = read.assignments.filter((a) => new Date(a.due).getTime() > Date.now());
            notes.push(
              `saved site for ${course.code}: read ${read.pagesRead.length} page(s), ${upcoming.length} upcoming deadline(s)` +
                (upcoming[0] ? `, next "${upcoming[0].title}" due ${fmtDate(upcoming[0].due)}` : ""),
            );
          }
          if (input.remove_course_site) {
            const course = findCourse(input.remove_course_site.course);
            if (course) course.sites = course.sites.filter((s) => s.url !== input.remove_course_site!.url);
            notes.push(`removed site from ${input.remove_course_site.course}`);
          }
          if (input.brief_hour !== undefined) user.schedule.briefHour = input.brief_hour;
          if (input.quiet_start !== undefined) user.schedule.quietStart = input.quiet_start;
          if (input.quiet_end !== undefined) user.schedule.quietEnd = input.quiet_end;
          if (input.internship_alerts !== undefined) user.internships.alerts = input.internship_alerts;
          if (input.internship_roles) user.internships.roles = input.internship_roles;
          if (input.internship_locations) user.internships.locations = input.internship_locations;
          if (input.needs_sponsorship !== undefined) user.internships.needsSponsorship = input.needs_sponsorship;
          if (input.unmute_companies) {
            const un = input.unmute_companies.map((c) => c.toLowerCase());
            user.internships.excludeCompanies = user.internships.excludeCompanies.filter((c) => !un.includes(c.toLowerCase()));
          }
          if (input.event_keywords) user.events.keywords = input.event_keywords;
          if (input.free_food !== undefined) user.events.freeFood = input.free_food;
          if (input.evenings_only !== undefined) user.events.eveningsOnly = input.evenings_only;
          clearHomeworkCache(user.id);
          save();
          return { ok: true, notes, settings_now: profileSummary(user) };
        }),
    }),

    betaZodTool({
      name: "remember",
      description: "Save a lasting fact or preference about the student (e.g. 'works Tuesdays 5-9pm', 'vegetarian').",
      inputSchema: z.object({ fact: z.string() }),
      run: (input) =>
        safe("remember", async () => {
          user.facts.push(input.fact);
          if (user.facts.length > 30) user.facts.shift();
          save();
          return { ok: true };
        }),
    }),
  ];
}

function context(user: UserState): string {
  const now = new Date().toLocaleString("en-US", { timeZone: TIMEZONE, dateStyle: "full", timeStyle: "short" });
  const offset = new Date().toLocaleString("en-US", { timeZone: TIMEZONE, timeZoneName: "longOffset" }).split(" ").pop();
  const apps = user.applications.length
    ? `\n\nApplication tracker:\n${user.applications.map((a) => `- ${a.company}: ${a.title} [${a.status}] id=${a.id}`).join("\n")}`
    : "";
  const reminders = user.reminders.filter((r) => !r.sentAt && !r.done);
  const rem = reminders.length ? `\n\nPending reminders:\n${reminders.map((r) => `- ${fmtDate(r.at)}: ${r.text}`).join("\n")}` : "";
  return (
    `Right now: ${now} (${TIMEZONE}, ${offset}).\n\n${profileSummary(user)}` +
    apps +
    rem +
    (user.facts.length ? `\n\nThings the student told you:\n${user.facts.map((f) => `- ${f}`).join("\n")}` : "")
  );
}

/** Earlier turns as plain text (proactive texts included, so "is the first one still open?" works). */
function historyMessages(user: UserState): Anthropic.Beta.BetaMessageParam[] {
  const msgs: Anthropic.Beta.BetaMessageParam[] = user.history.map((t) => ({ role: t.role, content: t.text }));
  if (msgs[0]?.role === "assistant") msgs.unshift({ role: "user", content: "(start of our text thread)" });
  return msgs;
}

/** Append the current message unless the caller already put it in history (bot.ts does). */
function withCurrentMessage(msgs: Anthropic.Beta.BetaMessageParam[], text: string): Anthropic.Beta.BetaMessageParam[] {
  const last = msgs.at(-1);
  if (last?.role === "user" && last.content === text) return msgs;
  return [...msgs, { role: "user", content: text }];
}

/** A tapback on the reply acts on the items it actually mentions (matched by link or title). */
function refFor(reply: string, listed: ToolContext["listed"]): MessageRef | undefined {
  const lower = reply.toLowerCase();
  const events = [...listed.events].filter(([, url]) => reply.includes(url)).map(([id]) => id);
  const jobs = [...listed.jobs].filter(([, url]) => reply.includes(url)).map(([id]) => id);
  const assignments = [...listed.assignments].filter(([, title]) => lower.includes(title.toLowerCase())).map(([key]) => key);
  if (!events.length && !jobs.length && !assignments.length) return { kind: "chat", text: reply };
  return { kind: "chat", events, jobs, assignments, text: reply };
}

export interface ChatResult {
  text: string;
  ref?: MessageRef;
  /** Bubbles to send after the reply: calendar files, confetti, fireworks. */
  extras: Reply[];
}

export async function chat(user: UserState, text: string, notify: ToolContext["notify"]): Promise<ChatResult> {
  const ctx: ToolContext = {
    user,
    notify,
    extras: [],
    listed: { events: new Map(), jobs: new Map(), assignments: new Map() },
    pagesRead: new Set(),
  };
  const final = await claude.beta.messages.toolRunner({
    model: MODEL,
    max_tokens: 16000,
    ...(MODEL_SUPPORTS_EFFORT ? { output_config: { effort: "low" as const } } : {}),
    ...(MODEL_SUPPORTS_FALLBACKS ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const } : {}),
    // Stable prefix (tools + SYSTEM) is cached; the per-turn context block comes after the breakpoint.
    system: [
      { type: "text", text: SYSTEM, cache_control: { type: "ephemeral" } },
      { type: "text", text: context(user) },
    ],
    tools: buildTools(ctx),
    messages: withCurrentMessage(historyMessages(user), text),
    max_iterations: 10,
  });

  if (final.stop_reason === "refusal") {
    return {
      text: "Sorry, I can't help with that one. Ask me about homework, internships, campus events, or anything else you want looked up.",
      extras: [],
    };
  }
  let reply = plainText(
    final.content
      .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
      .map((b) => b.text)
      .join("\n")
      .trim(),
  );
  if (!reply) reply = "Hmm, I got tangled up there. Mind asking that another way?";
  // Never an unsourced web answer: if the reply leans on pages it read but links none, add them.
  if (ctx.pagesRead.size && !/https?:\/\//.test(reply)) {
    reply += `\n\nSources:\n${[...ctx.pagesRead].slice(0, 3).join("\n")}`;
  }
  return { text: reply, ref: refFor(reply, ctx.listed), extras: ctx.extras };
}

/** iMessage shows markdown literally, so strip it whatever the model writes. */
function plainText(s: string): string {
  return s
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/__(.+?)__/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^\s*[-*]\s+/gm, "• ")
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, "$1: $2")
    .replace(/`([^`]+)`/g, "$1");
}
