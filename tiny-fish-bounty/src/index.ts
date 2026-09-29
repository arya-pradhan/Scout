import { Spectrum, richlink, type Space } from "spectrum-ts";
import { imessage, nativeContactCard } from "@spectrum-ts/imessage";
import { handleText, type Reply } from "./bot.ts";
import { isAllowed, normalizeSender } from "./config.ts";
import { startScheduler } from "./scheduler.ts";
import { getUser, save } from "./store.ts";

// Spectrum bridges the agent loop to iMessage. Docs: https://photon.codes/docs/spectrum-ts
const app = await Spectrum({
  projectId: process.env.PROJECT_ID!,
  projectSecret: process.env.PROJECT_SECRET!,
  providers: [imessage.config()],
});
const im = imessage(app);

async function deliver(space: Space, replies: Reply[]): Promise<void> {
  for (const r of replies) {
    try {
      if ("text" in r) await space.send(r.text);
      else if ("link" in r) await space.send(richlink(r.link));
      else await space.send(nativeContactCard());
    } catch (err) {
      // Rich links / contact cards are nice-to-haves; never let them break the reply.
      console.warn("[send] failed:", (err as Error).message);
      if ("link" in r) await space.send(r.link).catch(() => {});
    }
  }
}

// Proactive texts (brief, reminders, alerts) go to the chat saved from the user's last message.
startScheduler(async (user, text) => {
  if (!user.spaceId) return;
  const space = await im.space.get(user.spaceId);
  await deliver(space, [{ text }]);
});

// One message at a time per person, so replies never interleave.
const queues = new Map<string, Promise<void>>();

for await (const [space, message] of app.messages) {
  if (message.direction !== "inbound") continue;
  const senderId = normalizeSender(message.sender?.id ?? "");
  if (!senderId || !isAllowed(senderId)) {
    console.log(`[ignored] message from ${message.sender?.id ?? "unknown"} (not in ALLOWED_PHONES)`);
    continue;
  }

  const user = getUser(senderId);
  if (user.spaceId !== space.id) {
    user.spaceId = space.id;
    save();
  }

  const content = message.content;
  const text = content.type === "text" ? content.text : "";
  const prev = queues.get(senderId) ?? Promise.resolve();
  const next = prev.then(async () => {
    if (!text) {
      await deliver(space, [{ text: "I can only read text messages for now. Mind typing that out?" }]);
      return;
    }
    console.log(`[in] ${senderId}: ${text.slice(0, 80)}`);
    await app.responding(space, () => handleText(user, text, (replies) => deliver(space, replies)));
  });
  queues.set(senderId, next.catch((err) => console.error("[queue]", err)));
}
