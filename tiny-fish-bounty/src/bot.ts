// Routes one inbound text to onboarding, a quick command, or the Claude chat agent.
// Platform-agnostic: index.ts wires it to iMessage, scripts/chat.ts to a terminal.

import Anthropic from "@anthropic-ai/sdk";
import { chat } from "./agent.ts";
import { buildBrief } from "./brief.ts";
import { currentPrompt, handleOnboarding, isOnboarding, profileSummary, startOnboarding, type Reply } from "./onboarding.ts";
import { pushHistory, resetUser, save, type UserState } from "./store.ts";
import { TinyFishError } from "./tinyfish.ts";

export type { Reply };
export type Send = (replies: Reply[]) => Promise<void>;

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

export async function handleText(user: UserState, rawText: string, send: Send): Promise<void> {
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
        const answer = await chat(user, text, (t) => send([{ text: t }]));
        await send([{ text: answer }, ...currentPrompt(user)]);
        return;
      }
      const { replies, finished } = await handleOnboarding(user, text, (t) => send([{ text: t }]));
      await send(replies);
      if (finished) {
        user.internshipsSince = Date.now();
        const brief = await buildBrief(user, { greeting: true });
        if (brief) {
          pushHistory(user, "assistant", brief);
          await send([{ text: brief }]);
        }
        save();
      }
      return;
    }

    // Quick commands that don't need Claude.
    if (/^(settings|setup|my settings)$/i.test(text)) {
      await send([{ text: `${profileSummary(user)}\n\nTell me what to change, e.g. "brief at 9am" or "add a site for COMP 301: <link>". Text "reset" to redo setup.` }]);
      return;
    }
    if (/^(brief|morning brief|what'?s up today)$/i.test(text)) {
      const brief = (await buildBrief(user, { greeting: true }))!;
      pushHistory(user, "assistant", brief);
      save();
      await send([{ text: brief }]);
      return;
    }

    pushHistory(user, "user", text);
    const reply = await chat(user, text, async (t) => {
      pushHistory(user, "assistant", t);
      await send([{ text: t }]);
    });
    pushHistory(user, "assistant", reply);
    save();
    await send([{ text: reply }]);
  } catch (err) {
    console.error(`[bot] error for ${user.id}:`, err);
    save();
    await send([{ text: friendlyError(err) }]);
  }
}
