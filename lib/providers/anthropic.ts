import Anthropic from "@anthropic-ai/sdk";
import type { Delta, Provider } from "./index";

let _client: Anthropic | null = null;

/** Lazy so a missing API key surfaces as a catchable error at request time,
 *  not as a crash at module load. */
export function getClient(): Anthropic {
  if (!_client) {
    if (!process.env.ANTHROPIC_API_KEY) {
      throw new Error(
        "ANTHROPIC_API_KEY is not set. Add it to .env.local and restart the dev server.",
      );
    }
    _client = new Anthropic();
  }
  return _client;
}

export const SYSTEM_PROMPT = `You are a helpful, general-purpose AI assistant in a chat application.

Reply in whatever language the user writes in.

You have tools for fetching publisher news, reading LinkedIn profiles, summarizing YouTube videos, and checking the weather. Rules for using them:
- When a tool returns { ok: false }, tell the user plainly what you could not do and why, then continue the conversation. Never pretend the tool succeeded.
- News: present each story as a markdown link ([headline](url)) followed by a one-or-two sentence summary. Always state the source and the fetch time given by the tool.
- LinkedIn: only look up a profile when the user explicitly asks about that specific person - never volunteer a lookup. NEVER invent profile data. If the tool is not configured or the person is not found, say so plainly and offer a web search for public information, clearly labeled as coming from search rather than LinkedIn. For well-known public figures you may summarize general knowledge, clearly labeled as such.
- Weather: always state which resolved place the reading is for (names like Springfield are ambiguous), include units, and mention the local time of the reading. If the user gave no location, ask instead of guessing.
- YouTube: when the tool reports that no transcript was available, state that clearly and base the limited summary only on the returned title, channel and description. When a transcript is marked as truncated or sampled, mention that the summary covers the available portions. Output three to five key points plus a two-sentence overall summary, and include the video title and channel name.

Format responses with light markdown: [links](url), **bold**, and "- " bullet lists.`;

function makeProvider(id: string, label: string): Provider {
  return {
    id,
    label,
    supportsVision: true,
    supportsTools: true,
    async *stream(messages, tools, signal): AsyncIterable<Delta> {
      const stream = getClient().messages.stream(
        {
          model: id,
          max_tokens: 8192,
          system: [
            {
              type: "text",
              text: SYSTEM_PROMPT,
              cache_control: { type: "ephemeral" },
            },
          ],
          messages,
          tools,
        },
        { signal },
      );
      for await (const event of stream) {
        if (
          event.type === "content_block_delta" &&
          event.delta.type === "text_delta"
        ) {
          yield { type: "text", text: event.delta.text };
        }
      }
      const message = await stream.finalMessage();
      yield { type: "final", message };
    },
  };
}

export { DEFAULT_MODEL_ID } from "@/lib/models";

import { MODELS } from "@/lib/models";

export const PROVIDERS: Provider[] = MODELS.map((m) =>
  makeProvider(m.id, m.label),
);

export function getProvider(id: string): Provider {
  return PROVIDERS.find((p) => p.id === id) ?? PROVIDERS[0];
}

/** Titles always use the small fast model, regardless of the chat model. */
const TITLE_MODEL_ID = "claude-haiku-4-5";

/** Short conversation title from the first user message. Non-streaming. */
export async function generateTitle(
  firstUserText: string,
): Promise<string | null> {
  try {
    const response = await getClient().messages.create({
      model: TITLE_MODEL_ID,
      max_tokens: 32,
      system:
        "Generate a conversation title of at most five words, in the same language the message is written in. Reply with the title only - plain text, no quotes, no trailing punctuation.",
      messages: [{ role: "user", content: firstUserText.slice(0, 2000) }],
    });
    const block = response.content.find((b) => b.type === "text");
    let title = block && block.type === "text" ? block.text.trim() : null;
    if (!title) return null;
    // The model does not always honour "no quotes, no trailing punctuation".
    title = title
      .replace(/^["'«„”]+|["'»“”]+$/g, "")
      .replace(/[.!?…:;,]+$/g, "")
      .trim();
    return title ? title.slice(0, 80) : null;
  } catch {
    return null;
  }
}
