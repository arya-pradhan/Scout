import { Spectrum, attachment, richlink, type Space } from "spectrum-ts";
import { effect, imessage, nativeContactCard } from "@spectrum-ts/imessage";
import { handleTapback, handleText, type Reply } from "./bot.ts";
import { isAllowed, log, maskId, normalizeSender } from "./config.ts";
import { startScheduler } from "./scheduler.ts";
import { getUser, recordRef, save, type UserState } from "./store.ts";

// Spectrum bridges the agent loop to iMessage. Docs: https://photon.codes/docs/spectrum-ts
const app = await Spectrum({
  projectId: process.env.PROJECT_ID!,
  projectSecret: process.env.PROJECT_SECRET!,
  providers: [imessage.config()],
});
const im = imessage(app);
const EFFECTS = imessage.effect.message;

/** Send bubbles in order. Remembers what each one was about (for tapbacks). */
async function deliver(space: Space, user: UserState, replies: Reply[]): Promise<void> {
  for (const r of replies) {
    try {
      if ("text" in r) {
        const sent = r.effect
          ? await space.send(effect(r.text, EFFECTS[r.effect])).catch((err) => {
              console.warn("[send] effect failed, sending plain:", (err as Error).message);
              return space.send(r.text);
            })
          : await space.send(r.text);
        if (sent && r.ref) {
          recordRef(user, sent.id, r.ref);
          save();
        }
      } else if ("link" in r) await space.send(richlink(r.link));
      else if ("file" in r) await space.send(attachment(r.file.data, { name: r.file.name, mimeType: r.file.mimeType }));
      else await space.send(nativeContactCard());
    } catch (err) {
      // Rich links / contact cards are nice-to-haves; never let them break the reply.
      console.warn("[send] failed:", (err as Error).message);
      if ("link" in r) await space.send(r.link).catch(() => {});
      if ("file" in r) await space.send("Sorry, the calendar file didn't go through. Try again in a sec?").catch(() => {});
    }
  }
}

// Proactive texts (brief, reminders, alerts) go to the chat saved from the user's last message.
startScheduler(async (user, replies) => {
  if (!user.spaceId) return;
  const space = await im.space.get(user.spaceId);
  await deliver(space, user, replies);
});

// One message at a time per person, so replies never interleave.
const queues = new Map<string, Promise<void>>();

for await (const [space, message] of app.messages) {
  if (message.direction !== "inbound") continue;
  const senderId = normalizeSender(message.sender?.id ?? "");
  if (!senderId || !isAllowed(senderId)) {
    log(`[ignored] message from ${maskId(message.sender?.id ?? "")} (not in ALLOWED_PHONES)`);
    continue;
  }

  const user = getUser(senderId);
  if (user.spaceId !== space.id) {
    user.spaceId = space.id;
    save();
  }

  const content = message.content;
  const send = (replies: Reply[]) => deliver(space, user, replies);
  const prev = queues.get(senderId) ?? Promise.resolve();
  const next = prev.then(async () => {
    if (content.type === "reaction") {
      const target = content.target;
      const targetText = target?.content.type === "text" ? target.content.text : undefined;
      await handleTapback(user, content.emoji, target?.id, targetText, send);
      return;
    }
    if (content.type !== "text") {
      await send([{ text: "I can only read text messages for now. Mind typing that out?" }]);
      return;
    }
    log(`[in] ${maskId(senderId)}: ${content.text.slice(0, 80)}`);
    await app.responding(space, () => handleText(user, content.text, send));
  });
  queues.set(senderId, next.catch((err) => console.error("[queue]", err)));
}
