// Per-user memory, persisted to data/state.json after every change so a restart
// (or a reply the next day) picks up exactly where the conversation left off.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const STATE_PATH = process.env.STATE_PATH ?? "data/state.json";

export interface CourseSite {
  url: string;
  label: string;
  /** Deadline pages the TinyFish Agent found on this site; crawled directly on every check. */
  pages?: string[];
  /** Hash of the extracted assignment list (not raw HTML) so layout tweaks don't count as changes. */
  lastHash?: string;
  lastChecked?: number;
  /** Keys of assignments seen on this page, used to diff for "new assignment posted" alerts. */
  knownItems: string[];
  failures: number;
  brokenNotified?: boolean;
}

export interface Course {
  code: string; // e.g. "COMP 211"
  name?: string;
  sites: CourseSite[];
}

export interface InternshipPrefs {
  roles: string[]; // Simplify categories, e.g. "Software", "AI/ML/Data", "Quant"
  keywords: string[];
  locations: string[];
  remoteOk: boolean;
  needsSponsorship: boolean;
  alerts: boolean;
  /** Companies muted with a 👎 tapback. */
  excludeCompanies: string[];
}

/** What a bot message was about, so a tapback on it knows what to act on. */
export interface MessageRef {
  kind: "homework" | "reminder" | "internships" | "events" | "application" | "chat" | "text";
  assignments?: string[]; // assignment keys
  events?: string[]; // HeelLife event ids
  jobs?: string[]; // Simplify listing ids
  appIds?: string[];
  reminderId?: string;
  /** The bubble's text (for ❓ "explain this"). */
  text?: string;
}

export interface Reminder {
  id: string;
  text: string;
  at: number;
  createdAt: number;
  sentAt?: number;
  done?: boolean;
}

export type AppStatus = "saved" | "applied" | "interviewing" | "offer" | "rejected" | "closed";

/** What the TinyFish Agent found on a real application form (nothing filled in or submitted). */
export interface PrepResult {
  accepting_applications: boolean | null;
  requires_account: boolean;
  documents_required: string[];
  questions: Array<{ question: string; required: boolean; kind: string }>;
  deadline: string;
  notes: string;
  checkedAt: number;
  runId: string;
}

export interface Application {
  id: string;
  company: string;
  title: string;
  url: string;
  status: AppStatus;
  savedAt: number;
  statusAt: number;
  appliedAt?: number;
  prep?: PrepResult;
  lastCheckedAt?: number;
}

export interface EventPrefs {
  keywords: string[];
  freeFood: boolean;
  eveningsOnly: boolean;
}

export interface SchedulePrefs {
  briefHour: number; // 0-23
  quietStart: number; // 0-23, no proactive texts from here...
  quietEnd: number; // ...until here
}

export type OnboardingStep =
  | "intro"
  | "canvas"
  | "courses"
  | "sites"
  | "internships"
  | "events"
  | "schedule"
  | "done";

export interface ChatTurn {
  role: "user" | "assistant";
  text: string;
  at: number;
}

export interface UserState {
  id: string; // normalized phone / Apple ID
  spaceId?: string; // iMessage chat id, for proactive texts
  name?: string;
  onboarding: { step: OnboardingStep; courseIndex: number; started?: boolean; pending?: Record<string, unknown> };
  canvasIcs?: string; // secret URL: never echo back or log
  courses: Course[];
  internships: InternshipPrefs;
  events: EventPrefs;
  schedule: SchedulePrefs;
  facts: string[];
  history: ChatTurn[];
  doneAssignments: string[];
  seenInternshipIds: string[];
  /** Only listings posted after this (ms) trigger drop alerts: set when onboarding finishes so there's no flood. */
  internshipsSince?: number;
  sentKeys: string[]; // dedupe keys for proactive texts
  lastBriefDay?: string;
  lastWeeklyDay?: string;
  applications: Application[];
  reminders: Reminder[];
  /** Outbound message id → what it was about (last ~150). */
  messageRefs: Record<string, MessageRef>;
}

interface State {
  users: Record<string, UserState>;
  internships: { etag?: string; lastCheck?: number };
}

let state: State = load();

function load(): State {
  try {
    const loaded = JSON.parse(readFileSync(STATE_PATH, "utf8")) as State;
    for (const user of Object.values(loaded.users)) {
      withDefaults(user);
      // Older versions could save the same course site twice; keep the first of each URL.
      for (const course of user.courses) {
        course.sites = course.sites.filter((s, i, all) => all.findIndex((o) => o.url === s.url) === i);
      }
    }
    return loaded;
  } catch {
    return { users: {}, internships: {} };
  }
}

export function save(): void {
  mkdirSync(dirname(STATE_PATH), { recursive: true });
  const tmp = `${STATE_PATH}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2));
  renameSync(tmp, STATE_PATH);
}

export function newUser(id: string): UserState {
  return {
    id,
    onboarding: { step: "intro", courseIndex: 0 },
    courses: [],
    internships: {
      roles: [],
      keywords: [],
      locations: [],
      remoteOk: true,
      needsSponsorship: false,
      alerts: true,
      excludeCompanies: [],
    },
    events: { keywords: [], freeFood: false, eveningsOnly: false },
    schedule: { briefHour: 8, quietStart: 23, quietEnd: 8 },
    facts: [],
    history: [],
    doneAssignments: [],
    seenInternshipIds: [],
    sentKeys: [],
    applications: [],
    reminders: [],
    messageRefs: {},
  };
}

/** Fill fields added in later versions so older saved state keeps working. */
function withDefaults(user: UserState): void {
  user.applications ??= [];
  user.reminders ??= [];
  user.messageRefs ??= {};
  user.internships.excludeCompanies ??= [];
}

/** Remember what an outbound message was about (for tapbacks). */
export function recordRef(user: UserState, messageId: string, ref: MessageRef): void {
  user.messageRefs[messageId] = ref;
  const ids = Object.keys(user.messageRefs);
  for (const id of ids.slice(0, Math.max(0, ids.length - 150))) delete user.messageRefs[id];
}

export function shortId(): string {
  return Math.random().toString(36).slice(2, 8);
}

export function getUser(id: string): UserState {
  state.users[id] ??= newUser(id);
  return state.users[id];
}

export function resetUser(id: string): UserState {
  const prev = state.users[id];
  state.users[id] = { ...newUser(id), spaceId: prev?.spaceId };
  save();
  return state.users[id];
}

export function allUsers(): UserState[] {
  return Object.values(state.users);
}

export function internshipCache(): State["internships"] {
  return state.internships;
}

export function pushHistory(user: UserState, role: ChatTurn["role"], text: string): void {
  user.history.push({ role, text, at: Date.now() });
  if (user.history.length > 20) user.history.splice(0, user.history.length - 20);
}

/** Record a proactive-text key; returns false if it was already sent. */
export function markSent(user: UserState, key: string): boolean {
  if (user.sentKeys.includes(key)) return false;
  user.sentKeys.push(key);
  if (user.sentKeys.length > 500) user.sentKeys.splice(0, user.sentKeys.length - 500);
  return true;
}
