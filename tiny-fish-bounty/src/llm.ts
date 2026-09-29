// Shared Anthropic client + a structured-extraction helper.

import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type { z } from "zod";
import { MODEL } from "./config.ts";

export const claude = new Anthropic();

/**
 * Ask Claude to turn messy input (a user's text, a scraped page) into typed data.
 * Low effort: these are small, well-specified extraction jobs.
 */
export async function extract<T extends z.ZodType>(
  schema: T,
  instructions: string,
  input: string,
): Promise<z.infer<T>> {
  const response = await claude.messages.parse({
    model: MODEL,
    max_tokens: 16000,
    output_config: { effort: "low", format: zodOutputFormat(schema) },
    system: instructions,
    messages: [{ role: "user", content: input }],
  });
  if (response.stop_reason === "refusal" || response.parsed_output == null) {
    throw new Error(`extraction failed (stop_reason=${response.stop_reason})`);
  }
  return response.parsed_output;
}
