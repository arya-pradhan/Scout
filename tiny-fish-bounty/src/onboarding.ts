// First-run setup over text. A fixed step table (not free-form LLM chat) so every
// answer is validated and saved the same way each time. Claude only parses messy
// answers inside a step. State is saved after every step, so it resumes after restarts.
//
// Steps: name → school → Canvas → courses → course sites → where events are posted →
// event interests → what jobs they want → job boards → brief time. Works for any school.

import { z } from "zod";
import { DEFAULT_TIMEZONE, fmtDate, isValidTimezone, withTimezone } from "./config.ts";
import { extract } from "./llm.ts";
import { say, type Reply } from "./reply.ts";
import { courseCodeFrom, looksLikeCanvasFeed, readCanvasFeed } from "./sources/canvas.ts";
import { findCourseSite, readCourseSiteDeep, upsertSite } from "./sources/courseSites.ts";
import { detectEventSource, findEventsPage, getEvents } from "./sources/events.ts";
import { readJobBoardDeep } from "./sources/jobBoards.ts";
import { jobSourcesSummary, matchesPrefs, SIMPLIFY_ROLES } from "./sources/jobs.ts";
import { save, type OnboardingStep, type UserState } from "./store.ts";
import type { SearchResult } from "./tinyfish.ts";

const URL_RE = /https?:\/\/[^\s<>"]+/i;
const YES_RE = /^(y|ya|yes|yep|yeah|yup|sure|ok|okay|correct|right|looks good|lgtm|perfect|👍)(\b|$)/i;
const NEXT_RE = /^(next|no|nope|nah|done|skip|that'?s it|none)\b/i;

const ORDER: OnboardingStep[] = [
  "intro",
  "school",
  "canvas",
  "courses",
  "sites",
  "eventSource",
  "events",
  "internships",
  "jobBoards",
  "schedule",
  "done",
];

/** Where "skip" goes from each step (default: the next step). */
const SKIP_TO: Partial<Record<OnboardingStep, OnboardingStep>> = {
  eventSource: "internships", // no events source → no interests question
  internships: "schedule", // no job alerts → no boards question
};

/** Send an interim text while a slow step runs (e.g. the Agent browsing a site). */
type Notify = (text: string) => Promise<void>;

interface Step {
  ask(user: UserState): Reply[];
  handle(user: UserState, text: string, notify: Notify): Promise<{ replies: Reply[]; next?: OnboardingStep }>;
}

function linkIn(text: string): string | undefined {
  return text.match(URL_RE)?.[0]?.replace(/[).,]+$/, "");
}

/** A pasted link, or a pick ("2", "yes") from search candidates offered earlier. */
function chosenUrl(user: UserState, text: string): string | undefined {
  const t = text.trim();
  const candidates = (user.onboarding.pending?.candidates as string[] | undefined) ?? [];
  const pick = t.match(/^([1-3])\b/)?.[1];
  return linkIn(t) ?? (pick ? candidates[Number(pick) - 1] : undefined) ?? (YES_RE.test(t) ? candidates[0] : undefined);
}

function offerCandidates(user: UserState, what: string, results: SearchResult[]): Reply[] {
  user.onboarding.pending = { ...user.onboarding.pending, candidates: results.map((r) => r.url) };
  return [
    say(
      `Here's what I found for ${what}:\n` +
        results.map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}`).join("\n") +
        "\n\nReply with the number that's right, paste a different link, or say skip.",
    ),
    { link: results[0]!.url },
  ];
}

const schoolName = (user: UserState) => user.school?.name ?? "your school";

const steps: Record<Exclude<OnboardingStep, "done">, Step> = {
  intro: {
    ask: () => [
      say(
        "Hey! 👋 I'm Scout 🧭, your study copilot over text.\n\n" +
          "I keep an eye on your homework (Canvas + professor sites), campus events, and new job and internship postings, and I'll text you when something actually matters.\n\n" +
          "I only read the web. I'll never submit, RSVP, or apply to anything without asking you first.\n\n" +
          "Quick setup (~3 min). What should I call you?",
      ),
      { contactCard: true },
    ],
    async handle(user, text) {
      const m = text.match(/(?:i'?m|i am|my name is|call me|it'?s|this is)\s+([a-z][\w'-]*)/i);
      const words = text.trim().split(/\s+/);
      const name = m?.[1] ?? (words.length <= 3 ? words[0] : undefined);
      if (!name) return { replies: [say("Sorry, what's your first name?")] };
      user.name = name.charAt(0).toUpperCase() + name.slice(1);
      return { replies: [say(`Nice to meet you, ${user.name}!`)], next: "school" };
    },
  },

  school: {
    ask: () => [say("Step 1 of 7: What school do you go to? 🏫")],
    async handle(user, text) {
      const s = await extract(
        z.object({
          official_name: z.string().describe("The school's usual full name, e.g. 'University of Florida'"),
          iana_timezone: z.string().describe("IANA timezone of the main campus, e.g. 'America/Chicago'"),
          recognized: z.boolean().describe("false if this doesn't look like a real school"),
        }),
        "Identify the college or university the student named. Use the main campus for the timezone.",
        text,
      );
      if (!s.recognized || !s.official_name.trim()) {
        return { replies: [say("Hmm, I didn't catch the school. What's its full name? (e.g. University of Florida)")] };
      }
      const timezone = isValidTimezone(s.iana_timezone) ? s.iana_timezone : DEFAULT_TIMEZONE;
      user.school = { name: s.official_name.trim(), timezone };
      const zone =
        new Intl.DateTimeFormat("en-US", { timeZone: timezone, timeZoneName: "long" }).formatToParts(new Date()).find((p) => p.type === "timeZoneName")
          ?.value ?? timezone;
      return { replies: [say(`Got it: ${user.school.name} (${zone}) ✅`)], next: "canvas" };
    },
  },

  canvas: {
    ask: () => [
      say(
        "Step 2 of 7: Canvas 📚\n\n" +
          'If your school uses Canvas: open Calendar → click "Calendar Feed" (bottom right) → copy the link and paste it here.\n\n' +
          "It's a private read-only link, so I don't need your password. (No Canvas? Say skip.)",
      ),
    ],
    async handle(user, text) {
      const url = linkIn(text);
      if (!url) return { replies: [say("I need the link that ends in .ics. Paste it here, or say skip.")] };
      if (!looksLikeCanvasFeed(url)) {
        return {
          replies: [
            say(
              "Hmm, that doesn't look like a Canvas calendar feed. It should look like https://yourschool.instructure.com/feeds/calendars/user_….ics. Try again or say skip.",
            ),
          ],
        };
      }
      try {
        const items = await readCanvasFeed(url);
        const upcoming = items.filter((a) => new Date(a.due).getTime() > Date.now());
        const codes = [...new Set(upcoming.map((a) => a.course).filter((c) => courseCodeFrom(c)))];
        user.canvasIcs = url;
        user.onboarding.pending = { detected: codes };
        return {
          replies: [
            say(
              upcoming.length
                ? `Got it ✅ Found ${upcoming.length} upcoming item${upcoming.length === 1 ? "" : "s"}${codes.length ? ` across ${codes.join(", ")}` : ""}.`
                : "Connected ✅ Your feed works, but nothing is due yet.",
            ),
          ],
          next: "courses",
        };
      } catch (err) {
        return {
          replies: [say(`I couldn't read that feed (${(err as Error).message}). Double-check the link, or say skip for now.`)],
        };
      }
    },
  },

  courses: {
    ask(user) {
      const detected = (user.onboarding.pending?.detected as string[] | undefined) ?? user.courses.map((c) => c.code);
      if (!detected.length) {
        return [say("Step 3 of 7: What courses are you taking this semester? (e.g. BIO 101, MATH 233, ECON 310)")];
      }
      return [
        say(
          `Step 3 of 7: These look like your courses:\n${detected.map((c, i) => `${i + 1}. ${c}`).join("\n")}\n\n` +
            'Reply yes if that\'s right, or tell me what to change ("drop 2", "add PSYC 210").',
        ),
      ];
    },
    async handle(user, text) {
      const current = (user.onboarding.pending?.detected as string[] | undefined) ?? user.courses.map((c) => c.code);
      if (YES_RE.test(text.trim()) && current.length) {
        user.courses = current.map((code) => user.courses.find((c) => c.code === code) ?? { code, sites: [] });
        user.onboarding.courseIndex = 0;
        user.onboarding.pending = undefined;
        return { replies: [say(`Locked in: ${current.join(", ")} ✅`)], next: "sites" };
      }
      const { courses } = await extract(
        z.object({ courses: z.array(z.string().describe('Course code formatted like "BIO 101"')) }),
        "You maintain a student's course list. Apply the student's message to the current list and return the full updated list. " +
          "Numbers like 'drop 2' refer to positions in the current list. Normalize codes to 'DEPT 123'.",
        `Current list: ${JSON.stringify(current)}\nStudent: ${text}`,
      );
      user.onboarding.pending = { detected: courses };
      if (!courses.length) return { replies: [say("I didn't catch any course codes. Try something like: BIO 101, MATH 233")] };
      return {
        replies: [say(`Updated:\n${courses.map((c, i) => `${i + 1}. ${c}`).join("\n")}\n\nLook right? (yes, or more changes)`)],
      };
    },
  },

  sites: {
    ask(user) {
      const course = user.courses[user.onboarding.courseIndex];
      if (!course) return [];
      const n = user.onboarding.courseIndex + 1;
      return [
        say(
          `Step 4 of 7: Course sites (${n}/${user.courses.length})\n\n` +
            `Does ${course.code} have a website outside Canvas, like a schedule, syllabus, or assignments page?\n\n` +
            'Paste the link, say "find it" and I\'ll search, or say skip.',
        ),
      ];
    },
    async handle(user, text, notify) {
      const course = user.courses[user.onboarding.courseIndex];
      if (!course) return { replies: [], next: "eventSource" };
      const t = text.trim();
      const advance = (): { replies: Reply[]; next?: OnboardingStep } => {
        user.onboarding.pending = undefined;
        user.onboarding.courseIndex++;
        if (user.onboarding.courseIndex >= user.courses.length) return { replies: [], next: "eventSource" };
        return { replies: steps.sites.ask(user) };
      };

      const url = chosenUrl(user, t);
      if (!url && /find/i.test(t)) {
        const results = await findCourseSite(course.code, schoolName(user));
        if (!results.length) {
          return { replies: [say(`I searched but couldn't find a public site for ${course.code}. Paste a link if you have one, or say skip.`)] };
        }
        return { replies: offerCandidates(user, course.code, results) };
      }
      if (!url) {
        if (NEXT_RE.test(t)) return advance();
        return { replies: [say(`Paste a link for ${course.code}, say "find it", or say skip.`)] };
      }

      try {
        const read = await readCourseSiteDeep(url, course.code, () =>
          notify(`Nothing dated on that page itself, so I'm digging through the rest of the ${course.code} site… (~1 min) 🔎`),
        );
        const upcoming = read.assignments.filter((a) => new Date(a.due).getTime() > Date.now());
        upsertSite(course, url, read);
        user.onboarding.pending = undefined;
        const next = upcoming[0];
        const latestPast = read.assignments.at(-1);
        const where = read.pagesRead.length > 1 ? ` across ${read.pagesRead.length} pages of that site` : " on that page";
        const msg = next
          ? `I see ${upcoming.length} upcoming deadline${upcoming.length === 1 ? "" : "s"}${where}, next up "${next.title}" (due ${fmtDate(next.due)}). I'll check it daily and text you when something new is posted ✅`
          : latestPast
            ? `I can read that page, but everything on it is already past (latest: "${latestPast.title}", ${fmtDate(latestPast.due)}). Double-check it's this semester's site. I'll watch it either way ✅`
            : read.looksLikeCoursePage
              ? "That's the course page, but I don't see any dated assignments yet. I'll keep watching it ✅"
              : `Saved, but heads up: that page doesn't look like a ${course.code} page and has no dated assignments.`;
        return { replies: [say(`${msg}\n\nAny other page for ${course.code}? Paste it, or say next.`)] };
      } catch (err) {
        return { replies: [say(`I couldn't open that page (${(err as Error).message}). Try another link, or say skip.`)] };
      }
    },
  },

  eventSource: {
    ask: (user) => [
      say(
        "Step 5 of 7: Campus events 🎉\n\n" +
          `Where does ${schoolName(user)} post events? Paste the link (your student org site or campus calendar), say "find it" and I'll search, or say skip.`,
      ),
    ],
    async handle(user, text, notify) {
      const t = text.trim();
      const url = chosenUrl(user, t);
      if (!url && /find/i.test(t)) {
        const results = await findEventsPage(schoolName(user));
        if (!results.length) return { replies: [say("I searched but couldn't find it. Paste the link if you have one, or say skip.")] };
        return { replies: offerCandidates(user, `${schoolName(user)} events`, results) };
      }
      if (!url) {
        if (NEXT_RE.test(t)) {
          user.onboarding.pending = undefined;
          return { replies: [say("No problem, you can add it later.")], next: "internships" };
        }
        return { replies: [say('Paste the events page link, say "find it", or say skip.')] };
      }
      try {
        const source = await detectEventSource(url);
        if (source.kind === "page") await notify("Reading that page to find the events… 🔎");
        const previous = user.eventSource;
        user.eventSource = source;
        const events = await getEvents(user, { to: new Date(Date.now() + 14 * 24 * 3600_000), limit: 50 });
        if (!events.length) {
          user.eventSource = previous;
          return { replies: [say("I couldn't find any upcoming events with dates on that page. Try another link (like the full events list), or say skip.")] };
        }
        user.onboarding.pending = undefined;
        // Show something coming up, not a weeks-long event that started earlier.
        const first = events.find((e) => new Date(e.start).getTime() >= Date.now()) ?? events[0]!;
        const how = source.kind === "page" ? "I'll read that page for you" : "Connected";
        return {
          replies: [say(`${how} ✅ I see ${events.length}${events.length === 50 ? "+" : ""} events in the next 2 weeks, like "${first.name}" (${fmtDate(first.start)}).`)],
          next: "events",
        };
      } catch (err) {
        return { replies: [say(`I couldn't open that link (${(err as Error).message}). Try another, or say skip.`)] };
      }
    },
  },

  events: {
    ask: () => [
      say("What kind of events are you into? Free food, career fairs, hackathons, clubs, sports, music… And is it evenings only?"),
    ],
    async handle(user, text) {
      const p = await extract(
        z.object({
          keywords: z.array(z.string()).describe("Short lowercase topics to match event names/descriptions, e.g. 'career', 'hackathon', 'basketball'"),
          free_food: z.boolean(),
          evenings_only: z.boolean(),
        }),
        "Turn a student's campus event interests into matching keywords. Leave free food out of keywords; set free_food instead.",
        text,
      );
      Object.assign(user.events, { keywords: p.keywords, freeFood: p.free_food, eveningsOnly: p.evenings_only });
      const bits = [...p.keywords, p.free_food ? "free food 🍕" : ""].filter(Boolean);
      return {
        replies: [say(`Noted: ${bits.join(", ") || "a bit of everything"}${p.evenings_only ? " (evenings)" : ""} ✅`)],
        next: "internships",
      };
    },
  },

  internships: {
    ask: () => [
      say(
        "Step 6 of 7: Jobs & internships 💼\n\n" +
          "What are you looking for? Any field works, e.g. \"marketing internships in Chicago\", \"undergrad research in neuroscience\", or \"SWE or ML, NYC or remote\".\n\n" +
          "Or say none to skip job alerts.",
      ),
    ],
    async handle(user, text) {
      if (/^(none|no|nah|off)\b/i.test(text.trim())) {
        user.internships.alerts = false;
        return { replies: [say("No job alerts 👍 (you can still ask me anytime)")], next: "schedule" };
      }
      const p = await extract(
        z.object({
          description: z.string().describe("What they want, cleaned up, e.g. 'marketing internships in Chicago'"),
          is_tech: z.boolean().describe("true for software, data/ML, quant, product management or hardware roles"),
          title_keywords: z
            .array(z.string())
            .describe("Lowercase words a relevant job title would contain, e.g. ['marketing','brand','growth','social media']; empty if any role"),
          internship_only: z.boolean().describe("true if they want internships/co-ops/research positions rather than full-time jobs"),
          simplify_roles: z.array(z.enum(SIMPLIFY_ROLES)).describe("Only when is_tech; else empty"),
          locations: z.array(z.string()).describe("Cities/states as short names; empty = anywhere"),
          remote_ok: z.boolean(),
          needs_sponsorship: z.boolean(),
          search_query: z.string().describe("A good web search for new postings of this kind, e.g. 'summer 2027 marketing internship Chicago'"),
        }),
        `Map a student's job/internship goals onto these fields. Any field is fine (business, science, arts, public service, tech...).
SWE/software/backend/frontend → Software; ML/AI/data science → AI/ML/Data. Default remote_ok=true, needs_sponsorship=false unless stated.
Next summer is ${new Date().getFullYear() + 1}.`,
        text,
      );
      Object.assign(user.internships, {
        description: p.description,
        simplify: p.is_tech && p.simplify_roles.length > 0,
        roles: p.is_tech ? p.simplify_roles : [],
        keywords: p.title_keywords,
        internshipOnly: p.internship_only,
        locations: p.locations,
        remoteOk: p.remote_ok,
        needsSponsorship: p.needs_sponsorship,
        searchQuery: p.search_query,
        alerts: true,
      });
      const where = p.locations.length ? ` · ${p.locations.join(", ")}${p.remote_ok ? " or remote" : ""}` : "";
      return {
        replies: [
          say(
            `Got it: ${p.description}${where}. I'll search the web for new postings twice a day` +
              (user.internships.simplify ? " and watch the Simplify tech-internship list" : "") +
              ", and check a posting is really open before texting you ✅",
          ),
        ],
        next: "jobBoards",
      };
    },
  },

  jobBoards: {
    ask: () => [
      say(
        "Any job boards or careers pages you want me to check too? Like your department's job board or a company's careers page. Paste links one at a time, or say skip.\n\n" +
          "(Heads up: sites that need your login, like Handshake or LinkedIn, I can't read.)",
      ),
    ],
    async handle(user, text, notify) {
      const url = linkIn(text);
      if (!url) {
        if (NEXT_RE.test(text.trim())) return { replies: [], next: "schedule" };
        return { replies: [say("Paste a job board link, or say next.")] };
      }
      if (user.internships.boards.some((b) => b.url === url)) {
        return { replies: [say("I'm already watching that one. Another link, or say next.")] };
      }
      try {
        const { jobs, mode } = await readJobBoardDeep(url, () => notify("That page loads its postings in the browser, so I'm opening it for real… (~1-2 min) 🔎"));
        if (!jobs.length) {
          return { replies: [say("I couldn't find postings on that page (it may need a login). Try another link, or say next.")] };
        }
        user.internships.boards.push({
          url,
          label: new URL(url).hostname.replace(/^www\./, ""),
          knownIds: jobs.map((j) => j.id),
          lastChecked: Date.now(),
          failures: 0,
          mode,
        });
        const fits = jobs.filter((j) => matchesPrefs(j, user.internships));
        const eg = fits[0] ?? jobs[0]!;
        const fitNote = fits.length === jobs.length ? "" : `, ${fits.length} that fit what you're looking for`;
        return {
          replies: [
            say(
              `✅ I see ${jobs.length} posting${jobs.length === 1 ? "" : "s"} there${fitNote}, like "${eg.title}" at ${eg.company}. I'll text you when new ones that fit show up.\n\nAnother link, or say next.`,
            ),
          ],
        };
      } catch (err) {
        return { replies: [say(`I couldn't open that page (${(err as Error).message}). Try another link, or say next.`)] };
      }
    },
  },

  schedule: {
    ask: () => [
      say(
        'Step 7 of 7: When do you want your morning brief, and when should I stay quiet? ⏰\n\nDefault is an 8am brief and quiet from 11pm to 8am. Say "default" or tell me yours.',
      ),
    ],
    async handle(user, text) {
      if (!/^(default|ok|okay|sure|fine|yes|sounds good)\b/i.test(text.trim())) {
        const s = await extract(
          z.object({
            brief_hour: z.number().int().describe("0-23"),
            quiet_start: z.number().int().describe("0-23"),
            quiet_end: z.number().int().describe("0-23"),
          }),
          "Parse 24h hours. Defaults when unstated: brief_hour 8, quiet_start 23, quiet_end 8.",
          text,
        );
        const clamp = (h: number) => Math.min(23, Math.max(0, h));
        user.schedule = { briefHour: clamp(s.brief_hour), quietStart: clamp(s.quiet_start), quietEnd: clamp(s.quiet_end) };
      }
      return { replies: [], next: "done" };
    },
  },
};

const hr = (h: number) => `${h % 12 || 12}${h < 12 ? "am" : "pm"}`;

export function profileSummary(user: UserState): string {
  const courseLines = user.courses.length
    ? user.courses.map((c) => `• ${c.code}${c.sites.length ? `: ${c.sites.map((s) => s.label).join(", ")}` : " (Canvas only)"}`).join("\n")
    : "• none yet";
  const i = user.internships;
  const jobs = i.alerts ? `${i.description || "any"}${i.locations.length ? ` · ${i.locations.join(", ")}` : ""} (${jobSourcesSummary(i)})` : "alerts off";
  const interests = [...user.events.keywords, user.events.freeFood ? "free food" : ""].filter(Boolean).join(", ") || "anything";
  return (
    `📋 Your setup${user.name ? `, ${user.name}` : ""}\n\n` +
    `School: ${user.school?.name ?? "not set"}\n` +
    `Canvas feed: ${user.canvasIcs ? "connected ✅" : "not connected"}\n` +
    `Courses:\n${courseLines}\n` +
    `Events: ${user.eventSource ? `${user.eventSource.label} · ${interests}` : "no events source yet"}\n` +
    `Jobs: ${jobs}\n` +
    `Brief: ${hr(user.schedule.briefHour)} · quiet ${hr(user.schedule.quietStart)}–${hr(user.schedule.quietEnd)}`
  );
}

export function isOnboarding(user: UserState): boolean {
  return user.onboarding.step !== "done";
}

/** Start (or restart) onboarding: returns the first prompt. */
export function startOnboarding(user: UserState): Reply[] {
  user.onboarding = { step: "intro", courseIndex: 0, started: true };
  save();
  return steps.intro.ask(user);
}

/** Re-send the current step's question (e.g. after answering a side question mid-setup). */
export function currentPrompt(user: UserState): Reply[] {
  const step = user.onboarding.step;
  return step === "done" ? [] : steps[step].ask(user);
}

/**
 * Handle one inbound text during onboarding. Returns the replies, and `finished: true`
 * when setup just completed (the caller then sends the first brief).
 */
export async function handleOnboarding(
  user: UserState,
  text: string,
  notify: Notify = async () => {},
): Promise<{ replies: Reply[]; finished: boolean }> {
  return withTimezone(user.school?.timezone, async () => {
    const t = text.trim();
    const step = user.onboarding.step as Exclude<OnboardingStep, "done">;

    if (/^help$/i.test(t)) {
      return {
        replies: [say("We're getting you set up. Answer the question below, or say skip / back / restart."), ...steps[step].ask(user)],
        finished: false,
      };
    }
    if (/^restart$/i.test(t)) return { replies: startOnboarding(user), finished: false };
    if (/^back$/i.test(t)) {
      if (step === "sites" && user.onboarding.courseIndex > 0) user.onboarding.courseIndex--;
      else user.onboarding.step = ORDER[Math.max(0, ORDER.indexOf(step) - 1)]!;
      user.onboarding.pending = undefined;
      save();
      return { replies: currentPrompt(user), finished: false };
    }

    let result: { replies: Reply[]; next?: OnboardingStep };
    if (/^skip$/i.test(t) && step !== "sites" && step !== "jobBoards") {
      if (step === "internships") user.internships.alerts = false;
      result = { replies: [say("Skipped 👍")], next: SKIP_TO[step] ?? ORDER[ORDER.indexOf(step) + 1]! };
      user.onboarding.pending = undefined;
    } else {
      result = await steps[step].handle(user, t, notify);
    }

    const replies = [...result.replies];
    if (result.next) {
      user.onboarding.step = result.next;
      // "sites" with no courses (e.g. Canvas skipped and none typed) falls through.
      if (user.onboarding.step === "sites" && user.courses.length === 0) user.onboarding.step = "eventSource";
      replies.push(...currentPrompt(user));
    }
    save();

    if (user.onboarding.step === "done") {
      replies.push(say("All set! 🎉", undefined, "confetti"));
      replies.push(
        say(
          `${profileSummary(user)}\n\n` +
            'Text "settings" anytime to change this.\n' +
            "Tip: tap-back 👍 on a reminder to mark it done, ❤️ a posting to save it, ❤️ an event to add it to Google Calendar.\n\n" +
            "Pulling your first brief now…",
        ),
      );
      return { replies, finished: true };
    }
    return { replies, finished: false };
  });
}
