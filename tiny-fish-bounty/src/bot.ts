// Routes one inbound text (or tapback) to onboarding, a quick command, or the Claude chat
// agent. Platform-agnostic: index.ts wires it to iMessage, scripts/chat.ts to a terminal.

import Anthropic from "@anthropic-ai/sdk";
import { chat } from "./agent.ts";
import { trackerSummary } from "./applications.ts";
import { buildBrief, buildWeekAhead, repliesText } from "./brief.ts";
import { currentPrompt, handleOnboarding, isOnboarding, profileSummary, startOnboarding } from "./onboarding.ts";
import { handleReaction } from "./reactions.ts";
import { say, type Reply, type Send } from "./reply.ts";
import { pushHistory, resetUser, save, type UserState } from "./store.ts";
import { TinyFishError } from "./tinyfish.ts";
import { withTimezone } from "./config.ts";

export type { Reply, Send };

/** Texts that look like a side question during setup ("what can you do?"), not an answer. */
function isSideQuestion(user: UserState, text: string): boolean {
  const step = user.onboarding.step;
  return (step === "intro" || step === "canvas" || step === "sites") && text.includes("?") && !/https?:\/\//.test(text) && !/find/i.test(text);
}

function friendlyError(err: unknown): string {
  if (err instanceof TinyFishError) return `I couldn't reach the web just now (${err.endpoint} failed). Try again in a minute?`;
  if (err instanceof Anthropic.RateLimitError) return "I'm getting a lot of texts right now. Give me a minute and try again?";
  if (err instanceof Anthropic.APIError) return "My brain (Claude) is having a moment. Try again in a minute?";
  return "Sorry, something broke on my end. Try again in a sec?";
}

/** Interim texts from slow tools are part of the conversation too. */
const notifier = (user: UserState, send: Send) => async (t: string) => {
  pushHistory(user, "assistant", t);
  await send([say(t)]);
};

async function sendBrief(user: UserState, send: Send): Promise<void> {
  const brief = await buildBrief(user, { greeting: true });
  if (!brief) return;
  pushHistory(user, "assistant", repliesText(brief));
  save();
  await send(brief);
}

/** One inbound text. Everything inside runs in the student's own timezone. */
export function handleText(user: UserState, rawText: string, send: Send): Promise<void> {
  return withTimezone(user.school?.timezone, () => handleTextInTimezone(user, rawText, send));
}

async function handleTextInTimezone(user: UserState, rawText: string, send: Send): Promise<void> {
  const text = rawText.trim();
  if (!text) return;

  try {
    // Brand-new number: start setup no matter what they said.
    if (!user.onboarding.started) {
      await send(startOnboarding(user));
      return;
    }

    if (/^(reset|start over|redo setup)$/i.test(text)) {
      const fresh = resetUser(user.id);
      Object.assign(user, fresh);
      await send(startOnboarding(user));
      return;
    }

    if (isOnboarding(user)) {
      if (isSideQuestion(user, text)) {
        const answer = await chat(user, text, notifier(user, send));
        await send([say(answer.text), ...currentPrompt(user)]);
        return;
      }
      const { replies, finished } = await handleOnboarding(user, text, (t) => send([say(t)]));
      await send(replies);
      if (finished) {
        user.internshipsSince = Date.now();
        await sendBrief(user, send);
        save();
      }
      return;
    }

    // Quick commands that don't need Claude.
    if (/^(settings|setup|my settings)$/i.test(text)) {
      await send([say(`${profileSummary(user)}\n\nTell me what to change, e.g. "brief at 9am" or "add a site for BIO 101: <link>". Text "reset" to redo setup.`)]);
      return;
    }
    if (/^(brief|morning brief|what'?s up today)$/i.test(text)) {
      await sendBrief(user, send);
      return;
    }
    if (/^(week|my week|this week|week ahead|plan my week)$/i.test(text)) {
      const plan = await buildWeekAhead(user);
      const replies = plan ?? [say("Your week looks clear: nothing due, nothing saved, no matching events. 😌")];
      pushHistory(user, "assistant", repliesText(replies));
      save();
      await send(replies);
      return;
    }
    if (/^(apps|my apps|applications|my applications|tracker)$/i.test(text)) {
      const summary = trackerSummary(user);
      pushHistory(user, "assistant", summary);
      save();
      await send([say(summary, { kind: "text", text: summary })]);
      return;
    }

    pushHistory(user, "user", text);
    const result = await chat(user, text, notifier(user, send));
    const replies = [say(result.text, result.ref), ...result.extras];
    // Include extra bubbles (e.g. "📅 Tap to add…") so the next turn knows a file was already sent.
    pushHistory(user, "assistant", repliesText(replies));
    save();
    await send(replies);
  } catch (err) {
    console.error(`[bot] error for ${user.id}:`, err);
    save();
    await send([say(friendlyError(err))]);
  }
}

/** A tapback on one of the bot's bubbles. */
export async function handleTapback(
  user: UserState,
  emoji: string,
  targetId: string | undefined,
  targetText: string | undefined,
  send: Send,
): Promise<void> {
  if (isOnboarding(user)) return;
  try {
    const ref = targetId ? user.messageRefs[targetId] : undefined;
    // Tapback replies ("✅ Marked done…", calendar links) belong in the conversation too.
    const sendAndRemember: Send = async (replies) => {
      const text = repliesText(replies);
      if (text) {
        pushHistory(user, "assistant", text);
        save();
      }
      await send(replies);
    };
    await withTimezone(user.school?.timezone, () => handleReaction(user, emoji, ref, targetText, sendAndRemember));
  } catch (err) {
    console.error(`[bot] tapback error for ${user.id}:`, err);
    await send([say(friendlyError(err))]);
  }
}
