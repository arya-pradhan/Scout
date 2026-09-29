// The chat brain: every text after onboarding goes through Claude with tools that
// do the real web work via TinyFish. Claude decides which tools to call and writes
// the reply; it may only state facts that came back from a tool.

import type Anthropic from "@anthropic-ai/sdk";
import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";
import { fmtDate, MODEL, TIMEZONE } from "./config.ts";
import { clearHomeworkCache, upcomingHomework } from "./homework.ts";
import { claude } from "./llm.ts";
import { profileSummary } from "./onboarding.ts";
import { readCourseSiteDeep, upsertSite } from "./sources/courseSites.ts";
import { getEvents } from "./sources/events.ts";
import { loadListings, matchesPrefs, verifyPosting } from "./sources/internships.ts";
import { save, type UserState } from "./store.ts";
import { fetchPage, search } from "./tinyfish.ts";

const SYSTEM = `You are Heel Buddy, an assistant a UNC Chapel Hill student texts over iMessage. You help with three things: homework deadlines (Canvas + professor course sites), internships (the Simplify Summer 2027 list), and campus events (HeelLife). You can also research anything on the live web.

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
- You can only read the web. You cannot submit assignments, RSVP, apply, email, or buy anything. If asked, say so and give the link so the student can do it. Nothing is ever booked, bought, or sent on their behalf.
- Never repeat the student's Canvas feed link.

Tool tips:
- check_posting opens the live job page in a real browser and takes about a minute. Use it when the student asks whether a posting is still open or wants its details, not for every listing.
- "done with X" / "turned in X" means mark_done. Requests to change their setup (courses, course sites, brief time, alert preferences) mean update_settings.
- When the student shares a lasting preference or fact about themselves, save it with remember.`;

interface ToolContext {
  user: UserState;
  /** Send an interim text (e.g. "checking the live posting…") while a slow tool runs. */
  notify: (text: string) => Promise<void>;
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
          return {
            now: fmtDate(new Date()),
            items: items.map((a) => ({ course: a.course, title: a.title, due: fmtDate(a.due), url: a.url, source: a.source })),
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
          const { items } = await upcomingHomework(user, 60);
          const marked: string[] = [];
          for (const t of input.titles) {
            const needle = t.toLowerCase();
            const hit = items.find((a) => `${a.course} ${a.title}`.toLowerCase().includes(needle));
            if (hit && !user.doneAssignments.includes(hit.key)) {
              user.doneAssignments.push(hit.key);
              marked.push(`${hit.course}: ${hit.title}`);
            }
          }
          save();
          return { marked, not_found: input.titles.length - marked.length };
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
          return events.map((e) => ({
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
          return jobs.map((j) => ({
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
  return (
    `Right now: ${now} (${TIMEZONE}).\n\n${profileSummary(user)}` +
    (user.facts.length ? `\n\nThings the student told you:\n${user.facts.map((f) => `- ${f}`).join("\n")}` : "")
  );
}

/** Earlier turns as plain text (proactive texts included, so "is the first one still open?" works). */
function historyMessages(user: UserState): Anthropic.Beta.BetaMessageParam[] {
  const msgs: Anthropic.Beta.BetaMessageParam[] = user.history.map((t) => ({ role: t.role, content: t.text }));
  if (msgs[0]?.role === "assistant") msgs.unshift({ role: "user", content: "(start of our text thread)" });
  return msgs;
}

export async function chat(user: UserState, text: string, notify: ToolContext["notify"]): Promise<string> {
  const final = await claude.beta.messages.toolRunner({
    model: MODEL,
    max_tokens: 16000,
    output_config: { effort: "low" },
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    // Stable prefix (tools + SYSTEM) is cached; the per-turn context block comes after the breakpoint.
    system: [
      { type: "text", text: SYSTEM, cache_control: { type: "ephemeral" } },
      { type: "text", text: context(user) },
    ],
    tools: buildTools({ user, notify }),
    messages: [...historyMessages(user), { role: "user", content: text }],
    max_iterations: 8,
  });

  if (final.stop_reason === "refusal") {
    return "Sorry, I can't help with that one. Ask me about homework, internships, campus events, or anything else you want looked up.";
  }
  const reply = final.content
    .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();
  return reply || "Hmm, I got tangled up there. Mind asking that another way?";
}
