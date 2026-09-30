// Tapbacks as controls. A reaction on one of the bot's bubbles acts on what that bubble
// was about (its MessageRef):
//   👍 homework → mark done · 👍 reminder → complete · 👍/❤️ internships → save to tracker
//   ❤️ events or homework → calendar file (student still taps Add) · 👎 internships → mute company
//   ❓ anything → explain in more detail
// Anything else stays quiet.

import { calendarFor, markDone, saveJobs } from "./actions.ts";
import { chat } from "./agent.ts";
import { getListing } from "./sources/internships.ts";
import { say, type Send } from "./reply.ts";
import { pushHistory, save, type MessageRef, type UserState } from "./store.ts";

export type Tapback = "love" | "like" | "dislike" | "question" | "emphasize" | "laugh" | "other";

/** iMessage tapbacks can arrive as emoji or as names; normalize both. */
export function normalizeTapback(raw: string): Tapback {
  const t = raw.trim().toLowerCase();
  if (/^(❤️|❤|♥️|♥|love|heart|loved)$/.test(t)) return "love";
  if (/^(👍|👍🏻|👍🏼|👍🏽|👍🏾|👍🏿|like|liked|thumbsup|thumbs_up)$/.test(t)) return "like";
  if (/^(👎|👎🏻|👎🏼|👎🏽|👎🏾|👎🏿|dislike|disliked|thumbsdown|thumbs_down)$/.test(t)) return "dislike";
  if (/^(❓|❔|\?|question|questioned)$/.test(t)) return "question";
  if (/^(‼️|‼|!!|emphasize|emphasized)$/.test(t)) return "emphasize";
  if (/^(😂|🤣|haha|laugh|laughed)$/.test(t)) return "laugh";
  return "other";
}

export async function handleReaction(
  user: UserState,
  rawEmoji: string,
  ref: MessageRef | undefined,
  targetText: string | undefined,
  send: Send,
): Promise<void> {
  const kind = normalizeTapback(rawEmoji);
  console.log(`[tapback] ${user.id}: ${JSON.stringify(rawEmoji)} → ${kind} on ${ref?.kind ?? "unknown message"}`);

  if (kind === "question") {
    const about = ref?.text ?? targetText;
    if (!about) return;
    const answer = await chat(user, `Explain your earlier message in a bit more detail, and say what I can do about it:\n"${about.slice(0, 1500)}"`, (t) =>
      send([say(t)]),
    );
    pushHistory(user, "assistant", answer.text);
    save();
    await send([say(answer.text, answer.ref), ...answer.extras]);
    return;
  }
  if (!ref) return;

  // 👍 on homework (nudge, brief section, new-assignment alert) → done. Not on ordinary
  // chat replies: a 👍 on "here's what's due" means "thanks", not "I finished all of it".
  if (kind === "like" && ref.kind === "homework" && ref.assignments?.length) {
    const { marked, replies } = await markDone(user, ref.assignments);
    if (marked.length) await send([say(`✅ Marked done: ${marked.join(", ")}`), ...replies]);
    return;
  }

  // 👍 on a reminder → complete it.
  if (kind === "like" && ref.reminderId) {
    const r = user.reminders.find((x) => x.id === ref.reminderId);
    if (r && !r.done) {
      r.done = true;
      save();
      await send([say("✅ Nice, checked off.")]);
    }
    return;
  }

  // ❤️ on internships (or 👍 on an internship alert) → save to the tracker.
  if (((kind === "like" && ref.kind === "internships") || kind === "love") && ref.jobs?.length) {
    const saved = await saveJobs(user, ref.jobs);
    if (!saved.length) return send([say("Hmm, those listings aren't on the Simplify list anymore, so I couldn't save them.")]);
    const names = saved.map((a) => a.company).join(", ");
    await send([say(`💼 Saved ${names} to your tracker. Want me to open the application and see what it asks? (say "prep ${saved[0]!.company}")`)]);
    return;
  }

  // ❤️ on events or homework → calendar file.
  if (kind === "love" && (ref.events?.length || ref.assignments?.length)) {
    const { replies, missing } = await calendarFor(user, { events: ref.events, assignments: ref.assignments });
    if (!replies.length) return send([say("Those already passed or were marked done, so there's nothing to add.")]);
    await send(missing ? [...replies, say(`(${missing} item${missing === 1 ? "" : "s"} couldn't be found anymore, so I left them out.)`)] : replies);
    return;
  }

  // 👎 on internships → fewer from those companies.
  if (kind === "dislike" && ref.jobs?.length) {
    const companies = new Set<string>();
    for (const id of ref.jobs) {
      const job = await getListing(id).catch(() => undefined);
      if (job) companies.add(job.company);
    }
    if (!companies.size) return;
    user.internships.excludeCompanies = [...new Set([...user.internships.excludeCompanies, ...companies])];
    save();
    await send([say(`Got it, no more ${[...companies].join(", ")} roles. Want to tweak your filters instead? Just tell me.`)]);
  }
}
