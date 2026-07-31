import type Anthropic from "@anthropic-ai/sdk";
import { fetchNews } from "./news";
import { readLinkedInProfile } from "./linkedin";
import { summarizeYoutube } from "./youtube";

/** Every tool resolves to this — no tool ever throws. */
export type ToolResult =
  | { ok: true; data: unknown }
  | { ok: false; reason: string };

export const TOOL_DEFINITIONS: Anthropic.Tool[] = [
  {
    name: "fetch_news",
    description:
      "Fetch the latest stories from a named news publisher. Call this whenever the user asks for news, headlines, or latest stories from any publisher (e.g. BBC, Reuters, Hürriyet). Returns headlines with summaries, dates and links, plus the fetch time.",
    input_schema: {
      type: "object",
      properties: {
        publisher: {
          type: "string",
          description:
            "Publisher name as the user said it (e.g. 'BBC', 'the Guardian') or a domain (e.g. 'lemonde.fr').",
        },
        limit: {
          type: "integer",
          description: "Number of stories to return. Default 5.",
        },
      },
      required: ["publisher"],
    },
  },
  {
    name: "read_linkedin_profile",
    description:
      "Read a LinkedIn profile (name, headline, current company and title, location, previous roles) via a configured enrichment provider. Call this ONLY when the user explicitly asks about a specific person's LinkedIn - never volunteer a lookup. Accepts a LinkedIn URL, or a name plus company. Returns ok:false when access is not configured or the person is not in the provider's database - report that plainly and never invent profile data.",
    input_schema: {
      type: "object",
      properties: {
        url: { type: "string", description: "Full LinkedIn profile URL, if the user gave one." },
        name: { type: "string", description: "Person's full name, when no URL was given." },
        company: { type: "string", description: "Company the person works at, to disambiguate a name lookup." },
      },
      required: [],
    },
  },
  {
    name: "summarize_youtube",
    description:
      "Fetch metadata and the transcript (when available) of a YouTube video so it can be summarized accurately. Call this whenever the user shares a YouTube link or asks to summarize a video.",
    input_schema: {
      type: "object",
      properties: {
        url: { type: "string", description: "YouTube video URL." },
      },
      required: ["url"],
    },
  },
];

/** Human-readable status line shown in the UI while a tool runs. */
export function toolStatusLabel(name: string): string {
  switch (name) {
    case "fetch_news":
      return "Fetching headlines…";
    case "read_linkedin_profile":
      return "Looking up profile…";
    case "summarize_youtube":
      return "Reading video transcript…";
    default:
      return "Working…";
  }
}

export async function runTool(
  name: string,
  input: unknown,
): Promise<ToolResult> {
  try {
    const args = (input ?? {}) as Record<string, unknown>;
    switch (name) {
      case "fetch_news":
        return await fetchNews(
          String(args.publisher ?? ""),
          typeof args.limit === "number" ? args.limit : 5,
        );
      case "read_linkedin_profile":
        return await readLinkedInProfile({
          url: args.url == null ? undefined : String(args.url),
          name: args.name == null ? undefined : String(args.name),
          company: args.company == null ? undefined : String(args.company),
        });
      case "summarize_youtube":
        return await summarizeYoutube(String(args.url ?? ""));
      default:
        return { ok: false, reason: `Unknown tool: ${name}` };
    }
  } catch (err) {
    // Belt and braces: no tool call may ever throw into the stream loop.
    return {
      ok: false,
      reason: `Tool crashed: ${err instanceof Error ? err.message : "unknown error"}`,
    };
  }
}
