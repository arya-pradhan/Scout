// Internship application tracker + "what does this application ask?" prep.
// Prep sends the TinyFish Agent to the real application form to read the questions and
// required documents. It never fills in a field, signs in, or submits anything.

import { createHash } from "node:crypto";
import { fmtDate } from "./config.ts";
import type { Job } from "./sources/jobs.ts";
import { save, type Application, type AppStatus, type PrepResult, type UserState } from "./store.ts";
import { runAgent } from "./tinyfish.ts";

export function findApplication(user: UserState, query: string): Application | undefined {
  const q = query.toLowerCase().trim();
  return (
    user.applications.find((a) => a.id === query) ??
    user.applications.find((a) => a.company.toLowerCase() === q) ??
    user.applications.find((a) => `${a.company} ${a.title}`.toLowerCase().includes(q))
  );
}

export function saveApplication(
  user: UserState,
  job: { company: string; title: string; url: string; listingId?: string },
): { app: Application; isNew: boolean } {
  const existing = user.applications.find((a) => a.url === job.url || (job.listingId && a.id === job.listingId));
  if (existing) return { app: existing, isNew: false };
  const now = Date.now();
  const app: Application = {
    id: job.listingId ?? createHash("sha1").update(job.url).digest("hex").slice(0, 12),
    company: job.company,
    title: job.title,
    url: job.url,
    status: "saved",
    savedAt: now,
    statusAt: now,
  };
  user.applications.push(app);
  save();
  return { app, isNew: true };
}

export function saveListing(user: UserState, job: Job): { app: Application; isNew: boolean } {
  return saveApplication(user, { company: job.company, title: job.title, url: job.url, listingId: job.id });
}

export function setStatus(user: UserState, app: Application, status: AppStatus): void {
  app.status = status;
  app.statusAt = Date.now();
  if (status === "applied") app.appliedAt ??= Date.now();
  save();
}

const STATUS_EMOJI: Record<AppStatus, string> = {
  saved: "🔖",
  applied: "📨",
  interviewing: "🗣️",
  offer: "🎉",
  rejected: "✖️",
  closed: "🚫",
};

export function trackerSummary(user: UserState): string {
  if (!user.applications.length) {
    return 'Your tracker is empty. ❤️ an internship alert or say "save the Perchwell one" to start tracking.';
  }
  const order: AppStatus[] = ["offer", "interviewing", "applied", "saved", "closed", "rejected"];
  const apps = [...user.applications].sort((a, b) => order.indexOf(a.status) - order.indexOf(b.status));
  return (
    "💼 Your applications\n\n" +
    apps
      .map((a) => {
        const since = a.status === "saved" ? `saved ${fmtDate(a.savedAt)}` : `${a.status} ${fmtDate(a.statusAt)}`;
        const deadline = a.prep?.deadline ? ` · deadline ${a.prep.deadline}` : "";
        return `${STATUS_EMOJI[a.status]} ${a.company}: ${a.title}\n   ${since}${deadline}`;
      })
      .join("\n") +
    '\n\nTell me when things change, e.g. "I applied to Perchwell" or "got an interview at Notion".'
  );
}

/**
 * TinyFish Agent opens the posting, goes to the application form, and lists what it asks.
 * Read-only by design: the goal forbids typing, uploading, signing in, or submitting.
 */
export async function prepApplication(url: string): Promise<PrepResult> {
  const run = await runAgent<Omit<PrepResult, "checkedAt" | "runId">>({
    url,
    goal: `This is an internship posting. Find out what the application asks for, WITHOUT applying.
1. If there is an "Apply" button or link, click it to open the application form (it's fine to open it; do not fill it in).
2. List every question on the form that is not basic contact info (name, email, phone, address): e.g. essay/short-answer prompts, "why us", work authorization, graduation date, how did you hear about us. Mark which are required.
3. List the documents it asks for (resume, cover letter, transcript, portfolio, etc.).
4. Note the application deadline if one is stated anywhere.
5. If the form requires creating an account or signing in first, stop there and set requires_account to true.
Rules: Do NOT type into any field, upload anything, sign in, create an account, or press submit. Only read.`,
    outputSchema: {
      type: "object",
      properties: {
        accepting_applications: { type: "boolean", nullable: true },
        requires_account: { type: "boolean" },
        documents_required: { type: "array", items: { type: "string" } },
        questions: {
          type: "array",
          items: {
            type: "object",
            properties: {
              question: { type: "string" },
              required: { type: "boolean" },
              kind: { type: "string", description: "essay, short answer, yes/no, dropdown, date, file, other" },
            },
            required: ["question", "required", "kind"],
          },
        },
        deadline: { type: "string", description: "As written, or empty string" },
        notes: { type: "string", description: "Anything blocking, e.g. captcha, login wall, posting closed" },
      },
      required: ["accepting_applications", "requires_account", "documents_required", "questions", "deadline", "notes"],
    },
    maxSteps: 25,
    maxDurationSeconds: 150,
  });
  const r = run.result;
  if (!r) throw new Error("the agent finished without reading the application");
  // COMPLETED doesn't mean the goal succeeded.
  if (/captcha|blocked|access denied/i.test(r.notes ?? "")) r.accepting_applications = null;
  return { ...r, checkedAt: Date.now(), runId: run.runId };
}

/** Human-readable prep result for iMessage. */
export function prepSummary(app: Application, prep: PrepResult): string {
  const lines: string[] = [`📝 ${app.company}: ${app.title}`];
  if (prep.accepting_applications === false) lines.push("⚠️ This posting doesn't seem to be accepting applications anymore.");
  if (prep.requires_account) lines.push("You'll need to create an account on their site to see the full form.");
  if (prep.documents_required.length) lines.push(`Documents: ${prep.documents_required.join(", ")}`);
  const qs = prep.questions.filter((q) => q.question.trim());
  if (qs.length) {
    lines.push("Questions:");
    qs.slice(0, 8).forEach((q, i) => lines.push(`${i + 1}. ${q.question}${q.required ? "" : " (optional)"}`));
    if (qs.length > 8) lines.push(`…plus ${qs.length - 8} more`);
  } else if (!prep.requires_account) {
    lines.push("No extra questions beyond contact info.");
  }
  if (prep.deadline) lines.push(`Deadline: ${prep.deadline}`);
  lines.push(app.url);
  return lines.join("\n");
}
