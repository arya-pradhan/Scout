// First-run setup over text. A fixed step table (not free-form LLM chat) so every
// answer is validated and saved the same way each time. Claude only parses messy
// answers inside a step. State is saved after every step, so it resumes after restarts.

import { z } from "zod";
import { courseCodeFrom, looksLikeCanvasFeed, readCanvasFeed } from "./sources/canvas.ts";
import { findCourseSite, readCourseSiteDeep, upsertSite } from "./sources/courseSites.ts";
import { fmtDate } from "./config.ts";
import { extract } from "./llm.ts";
import { save, type OnboardingStep, type UserState } from "./store.ts";

export type Reply = { text: string } | { link: string } | { contactCard: true };

const say = (text: string): Reply => ({ text });
const URL_RE = /https?:\/\/[^\s<>"]+/i;
const YES_RE = /^(y|ya|yes|yep|yeah|yup|sure|ok|okay|correct|right|looks good|lgtm|perfect|👍)(\b|$)/i;
const NEXT_RE = /^(next|no|nope|nah|done|skip|that'?s it|none)\b/i;

const ORDER: OnboardingStep[] = ["intro", "canvas", "courses", "sites", "internships", "events", "schedule", "done"];

/** Send an interim text while a slow step runs (e.g. the Agent browsing a course site). */
type Notify = (text: string) => Promise<void>;

interface Step {
  ask(user: UserState): Reply[];
  handle(user: UserState, text: string, notify: Notify): Promise<{ replies: Reply[]; next?: OnboardingStep }>;
}

const steps: Record<Exclude<OnboardingStep, "done">, Step> = {
  intro: {
    ask: () => [
      say(
        "Hey! 👋 I'm iRameses, your UNC agent over text.\n\n" +
          "I keep an eye on your homework (Canvas + professor sites), new internship drops, and campus events, and I'll text you when something actually matters.\n\n" +
          "I only read the web. I'll never submit, RSVP, or apply to anything without asking you first.\n\n" +
          "Quick setup (~2 min). What should I call you?",
      ),
      { contactCard: true },
    ],
    async handle(user, text) {
      const m = text.match(/(?:i'?m|i am|my name is|call me|it'?s|this is)\s+([a-z][\w'-]*)/i);
      const words = text.trim().split(/\s+/);
      const name = m?.[1] ?? (words.length <= 3 ? words[0] : undefined);
      if (!name) return { replies: [say("Sorry, what's your first name?")] };
      user.name = name.charAt(0).toUpperCase() + name.slice(1);
      return { replies: [say(`Nice to meet you, ${user.name}! 🐏`)], next: "canvas" };
    },
  },

  canvas: {
    ask: () => [
      say(
        "Step 1 of 5: Canvas 📚\n\n" +
          'In Canvas, open Calendar → click "Calendar Feed" (bottom right) → copy the link and paste it here.\n\n' +
          "It's a private read-only link, so I don't need your password. (Or say skip.)",
      ),
    ],
    async handle(user, text) {
      const url = text.match(URL_RE)?.[0]?.replace(/[).,]+$/, "");
      if (!url) return { replies: [say("I need the link that ends in .ics. Paste it here, or say skip.")] };
      if (!looksLikeCanvasFeed(url)) {
        return {
          replies: [
            say(
              "Hmm, that doesn't look like a Canvas calendar feed. It should look like https://canvas.unc.edu/feeds/calendars/user_….ics. Try again or say skip.",
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
        return [say("Step 2 of 5: What courses are you taking this semester? (e.g. COMP 211, MATH 233, STOR 435)")];
      }
      return [
        say(
          `Step 2 of 5: These look like your courses:\n${detected.map((c, i) => `${i + 1}. ${c}`).join("\n")}\n\n` +
            'Reply yes if that\'s right, or tell me what to change ("drop 2", "add COMP 455").',
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
        z.object({ courses: z.array(z.string().describe('Course code formatted like "COMP 211"')) }),
        "You maintain a student's course list. Apply the student's message to the current list and return the full updated list. " +
          "Numbers like 'drop 2' refer to positions in the current list. Normalize codes to 'DEPT 123'.",
        `Current list: ${JSON.stringify(current)}\nStudent: ${text}`,
      );
      user.onboarding.pending = { detected: courses };
      if (!courses.length) return { replies: [say("I didn't catch any course codes. Try something like: COMP 211, MATH 233")] };
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
          `Step 3 of 5: Course sites (${n}/${user.courses.length})\n\n` +
            `Does ${course.code} have a website outside Canvas, like a schedule, syllabus, or assignments page?\n\n` +
            'Paste the link, say "find it" and I\'ll search, or say skip.',
        ),
      ];
    },
    async handle(user, text, notify) {
      const course = user.courses[user.onboarding.courseIndex];
      if (!course) return { replies: [], next: "internships" };
      const t = text.trim();
      const candidates = (user.onboarding.pending?.candidates as string[] | undefined) ?? [];
      const advance = (): { replies: Reply[]; next?: OnboardingStep } => {
        user.onboarding.pending = undefined;
        user.onboarding.courseIndex++;
        if (user.onboarding.courseIndex >= user.courses.length) return { replies: [], next: "internships" };
        return { replies: steps.sites.ask(user) };
      };

      let url = t.match(URL_RE)?.[0]?.replace(/[).,]+$/, "");
      const pick = t.match(/^([1-3])\b/)?.[1];
      if (!url && pick && candidates[Number(pick) - 1]) url = candidates[Number(pick) - 1];
      if (!url && YES_RE.test(t) && candidates[0]) url = candidates[0];

      if (!url && /find/i.test(t)) {
        const results = await findCourseSite(course.code);
        if (!results.length) {
          return {
            replies: [say(`I searched but couldn't find a public site for ${course.code}. Paste a link if you have one, or say skip.`)],
          };
        }
        user.onboarding.pending = { candidates: results.map((r) => r.url) };
        return {
          replies: [
            say(
              `Here's what I found for ${course.code}:\n` +
                results.map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}`).join("\n") +
                "\n\nReply with the number that's right, paste a different link, or say skip.",
            ),
            { link: results[0]!.url },
          ],
        };
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

  internships: {
    ask: () => [
      say(
        "Step 4 of 5: Internships 💼\n\n" +
          "I watch the Simplify Summer 2027 list and text you when matching roles drop. What are you looking for?\n\n" +
          'e.g. "SWE or ML, NYC or remote, no sponsorship needed". Or say none to turn this off.',
      ),
    ],
    async handle(user, text) {
      if (/^(none|no|nah|off)\b/i.test(text.trim())) {
        user.internships.alerts = false;
        return { replies: [say("No internship alerts 👍 (you can still ask me anytime)")], next: "events" };
      }
      const p = await extract(
        z.object({
          roles: z.array(z.enum(["Software", "AI/ML/Data", "Quant", "Product", "Hardware"])),
          keywords: z.array(z.string()).describe("Extra title keywords, e.g. 'frontend', 'security'; empty if none"),
          locations: z.array(z.string()).describe("Cities/states as short names, e.g. 'NYC', 'SF', 'Seattle', 'NC'; empty = anywhere"),
          remote_ok: z.boolean(),
          needs_sponsorship: z.boolean(),
        }),
        "Map a student's internship preferences onto these fields. SWE/software/backend/frontend → Software. ML/AI/data science → AI/ML/Data. " +
          "Default remote_ok=true, needs_sponsorship=false unless stated.",
        text,
      );
      Object.assign(user.internships, {
        roles: p.roles,
        keywords: p.keywords,
        locations: p.locations,
        remoteOk: p.remote_ok,
        needsSponsorship: p.needs_sponsorship,
        alerts: true,
      });
      const where = p.locations.length ? p.locations.join(", ") + (p.remote_ok ? " or remote" : "") : "anywhere";
      return {
        replies: [
          say(
            `Got it: ${p.roles.join(" + ") || "any role"} · ${where}${p.needs_sponsorship ? " · needs sponsorship" : ""}. ` +
              "When a match drops, I'll check the real posting is open before texting you ✅",
          ),
        ],
        next: "events",
      };
    },
  },

  events: {
    ask: () => [
      say(
        "Step 5 of 5: Campus life 🎉\n\nWhat kind of events are you into? Free food, hackathons, career fairs, clubs, sports… And is it evenings only?",
      ),
    ],
    async handle(user, text) {
      const p = await extract(
        z.object({
          keywords: z
            .array(z.string())
            .describe("Short lowercase topics to match event names/descriptions, e.g. 'hackathon', 'career', 'basketball'"),
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
        next: "schedule",
      };
    },
  },

  schedule: {
    ask: () => [
      say(
        'Last thing ⏰ When do you want your morning brief, and when should I stay quiet?\n\nDefault is an 8am brief and quiet from 11pm to 8am. Say "default" or tell me yours.',
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
    ? user.courses
        .map((c) => `• ${c.code}${c.sites.length ? `: ${c.sites.map((s) => s.label).join(", ")}` : " (Canvas only)"}`)
        .join("\n")
    : "• none yet";
  const i = user.internships;
  return (
    `📋 Your setup${user.name ? `, ${user.name}` : ""}\n\n` +
    `Canvas feed: ${user.canvasIcs ? "connected ✅" : "not connected"}\n` +
    `Courses:\n${courseLines}\n` +
    `Internships: ${i.alerts ? `${i.roles.join(" + ") || "any role"} · ${i.locations.join(", ") || "anywhere"}${i.remoteOk ? " (+remote)" : ""}` : "alerts off"}\n` +
    `Events: ${[...user.events.keywords, user.events.freeFood ? "free food" : ""].filter(Boolean).join(", ") || "anything"}\n` +
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
  const t = text.trim();
  const step = user.onboarding.step as Exclude<OnboardingStep, "done">;

  if (/^help$/i.test(t)) {
    return { replies: [say("We're getting you set up. Answer the question below, or say skip / back / restart."), ...steps[step].ask(user)], finished: false };
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
  if (/^skip$/i.test(t) && step !== "sites") {
    result = { replies: [say("Skipped 👍")], next: ORDER[ORDER.indexOf(step) + 1]! };
    if (step === "canvas") user.onboarding.pending = undefined;
  } else {
    result = await steps[step].handle(user, t, notify);
  }

  const replies = [...result.replies];
  if (result.next) {
    user.onboarding.step = result.next;
    // "sites" with no courses (e.g. Canvas skipped and none typed) falls through.
    if (user.onboarding.step === "sites" && user.courses.length === 0) user.onboarding.step = "internships";
    replies.push(...currentPrompt(user));
  }
  save();

  if (user.onboarding.step === "done") {
    replies.push(say(`All set 🎉\n\n${profileSummary(user)}\n\nText "settings" anytime to see or change this. Pulling your first brief now…`));
    return { replies, finished: true };
  }
  return { replies, finished: false };
}
