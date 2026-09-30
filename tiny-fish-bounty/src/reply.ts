// What the bot sends. Platform-agnostic: index.ts maps these onto iMessage content,
// scripts/chat.ts prints them in a terminal.

import type { MessageRef } from "./store.ts";

export type Effect = "confetti" | "fireworks" | "celebration";

export type Reply =
  /** `ref` remembers what this bubble is about, so a tapback on it can act (👍 done, ❤️ save…). */
  | { text: string; ref?: MessageRef; effect?: Effect }
  | { link: string }
  | { contactCard: true }
  /** An attachment, e.g. a .ics the student taps to add to Apple Calendar. */
  | { file: { name: string; mimeType: string; data: Buffer } };

export type Send = (replies: Reply[]) => Promise<void>;

export const say = (text: string, ref?: MessageRef, effect?: Effect): Reply => ({ text, ref, effect });
