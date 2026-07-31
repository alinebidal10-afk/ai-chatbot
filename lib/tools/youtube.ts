import { Innertube } from "youtubei.js";
import { getClient } from "@/lib/providers/anthropic";
import type { ToolResult } from "./index";

/**
 * YouTube metadata + transcripts via youtubei.js (the maintained Innertube
 * client — the official Data API cannot download captions without the video
 * owner's OAuth). Long transcripts are chunk-summarised with the small fast
 * model rather than truncated: silently summarising only the start of a
 * long video is the most likely way to be confidently wrong.
 */

const CHUNK_CHARS = 6000;
// Below this the whole transcript goes to the chat model directly.
const DIRECT_LIMIT = CHUNK_CHARS * 2;
const SUMMARY_MODEL = "claude-haiku-4-5";

export function extractVideoId(url: string): string | null {
  const patterns = [
    /youtu\.be\/([A-Za-z0-9_-]{11})/,
    /[?&]v=([A-Za-z0-9_-]{11})/,
    /youtube\.com\/(?:shorts|embed|live)\/([A-Za-z0-9_-]{11})/,
  ];
  for (const p of patterns) {
    const m = url.match(p);
    if (m) return m[1];
  }
  return null;
}

let _yt: Promise<Innertube> | null = null;
function getInnertube(): Promise<Innertube> {
  if (!_yt) _yt = Innertube.create();
  return _yt;
}

/**
 * Fallback transcript path. youtubei.js's get_transcript endpoint currently
 * returns 400 from server environments, and the caption URLs in its own
 * player response come back empty (proof-of-origin token). A raw InnerTube
 * player call with the ANDROID client still hands out caption-track URLs
 * that download — verified working.
 */
const ANDROID_UA =
  "com.google.android.youtube/20.10.38 (Linux; U; Android 11) gzip";

interface RawCaptionTrack {
  baseUrl: string;
  languageCode?: string;
  kind?: string;
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&#0?39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

async function fetchTranscriptViaAndroid(
  videoId: string,
): Promise<{ text: string; language: string | null } | null> {
  try {
    const res = await fetch("https://www.youtube.com/youtubei/v1/player", {
      method: "POST",
      headers: { "content-type": "application/json", "user-agent": ANDROID_UA },
      body: JSON.stringify({
        context: {
          client: {
            clientName: "ANDROID",
            clientVersion: "20.10.38",
            androidSdkVersion: 30,
            hl: "en",
          },
        },
        videoId,
      }),
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as {
      captions?: {
        playerCaptionsTracklistRenderer?: { captionTracks?: RawCaptionTrack[] };
      };
    };
    const tracks =
      data.captions?.playerCaptionsTracklistRenderer?.captionTracks ?? [];
    if (tracks.length === 0) return null;
    // Prefer human captions, then English, then anything (auto-generated ok)
    const human = tracks.filter((t) => t.kind !== "asr");
    const pool = human.length > 0 ? human : tracks;
    const track =
      pool.find((t) => t.languageCode?.startsWith("en")) ?? pool[0];

    const sep = track.baseUrl.includes("?") ? "&" : "?";
    const body = await fetch(`${track.baseUrl}${sep}fmt=json3`, {
      headers: { "user-agent": ANDROID_UA },
      signal: AbortSignal.timeout(10000),
    }).then((r) => (r.ok ? r.text() : ""));
    if (!body) return null;

    let text = "";
    try {
      const doc = JSON.parse(body) as {
        events?: { segs?: { utf8?: string }[] }[];
      };
      text = (doc.events ?? [])
        .flatMap((e) => e.segs ?? [])
        .map((s) => s.utf8 ?? "")
        .join("");
    } catch {
      // timedtext XML: <text ...>…</text> (srv1) or <p ...>…</p> (format 3)
      text = [
        ...body.matchAll(/<(?:text|p)\b[^>]*>([\s\S]*?)<\/(?:text|p)>/g),
      ]
        .map((m) => decodeEntities(m[1].replace(/<[^>]+>/g, " ")))
        .join(" ");
    }
    text = text.replace(/\s+/g, " ").trim();
    return text ? { text, language: track.languageCode ?? null } : null;
  } catch {
    return null;
  }
}

async function fetchOembed(videoId: string) {
  try {
    const res = await fetch(
      `https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${videoId}&format=json`,
      { signal: AbortSignal.timeout(8000) },
    );
    if (!res.ok) return null;
    return (await res.json()) as { title?: string; author_name?: string };
  } catch {
    return null;
  }
}

function chunkText(text: string, size: number): string[] {
  const chunks: string[] = [];
  for (let i = 0; i < text.length; i += size) {
    chunks.push(text.slice(i, i + size));
  }
  return chunks;
}

async function summarizeChunk(
  title: string,
  index: number,
  total: number,
  chunk: string,
): Promise<string> {
  const response = await getClient().messages.create({
    model: SUMMARY_MODEL,
    max_tokens: 400,
    system:
      "You condense one portion of a video transcript into 4-8 terse factual notes, in the transcript's own language. No introduction, no conclusions about parts you have not seen.",
    messages: [
      {
        role: "user",
        content: `Video: "${title}". Transcript portion ${index + 1} of ${total}:\n\n${chunk}`,
      },
    ],
  });
  const block = response.content.find((b) => b.type === "text");
  return block && block.type === "text" ? block.text.trim() : "";
}

/** Map-reduce over a long transcript: summarise chunks, then the summaries. */
async function condenseTranscript(
  title: string,
  transcript: string,
): Promise<{ digest: string; chunkCount: number } | null> {
  try {
    const chunks = chunkText(transcript, CHUNK_CHARS);
    const notes = await Promise.all(
      chunks.map((c, i) => summarizeChunk(title, i, chunks.length, c)),
    );
    const joined = notes
      .map((n, i) => `[Portion ${i + 1}/${chunks.length}]\n${n}`)
      .join("\n\n");
    const response = await getClient().messages.create({
      model: SUMMARY_MODEL,
      max_tokens: 800,
      system:
        "You merge per-portion transcript notes into one coherent set of notes covering the WHOLE video, in the notes' own language. Keep concrete facts; note the video's overall arc.",
      messages: [{ role: "user", content: `Video: "${title}".\n\n${joined}` }],
    });
    const block = response.content.find((b) => b.type === "text");
    const digest = block && block.type === "text" ? block.text.trim() : "";
    return digest ? { digest, chunkCount: chunks.length } : null;
  } catch {
    return null;
  }
}

export async function summarizeYoutube(url: string): Promise<ToolResult> {
  try {
    const videoId = extractVideoId(url);
    if (!videoId) {
      return { ok: false, reason: "Could not extract a video ID from that URL." };
    }

    let title: string | null = null;
    let channel: string | null = null;
    let durationSeconds: number | null = null;
    let description: string | null = null;
    let transcript: string | null = null;
    let transcriptLanguage: string | null = null;

    try {
      const yt = await getInnertube();
      const info = await yt.getInfo(videoId);
      title = info.basic_info.title ?? null;
      channel = info.basic_info.author ?? null;
      durationSeconds = info.basic_info.duration ?? null;
      description = info.basic_info.short_description?.slice(0, 1500) ?? null;

      try {
        const t = await info.getTranscript();
        transcriptLanguage = t.selectedLanguage ?? null;
        const segments = t.transcript?.content?.body?.initial_segments ?? [];
        const text = segments
          .map((s) => ("snippet" in s ? (s.snippet?.text ?? "") : ""))
          .join(" ")
          .replace(/\s+/g, " ")
          .trim();
        transcript = text || null;
      } catch {
        transcript = null;
      }
      if (!transcript) {
        // get_transcript can 400 while caption tracks still exist — try the
        // raw ANDROID caption path before concluding there are no captions.
        const fallback = await fetchTranscriptViaAndroid(videoId);
        if (fallback) {
          transcript = fallback.text;
          transcriptLanguage = fallback.language;
        }
      }
    } catch {
      // Innertube failed entirely — oEmbed still gives title + channel.
      const oembed = await fetchOembed(videoId);
      title = oembed?.title ?? null;
      channel = oembed?.author_name ?? null;
    }

    if (!title) {
      return {
        ok: false,
        reason: "The video does not exist, is private, or YouTube is unreachable.",
      };
    }

    const base = {
      videoId,
      title,
      channel,
      durationSeconds,
      outputShape:
        "Answer with: video title, channel, three to five key points, then a two-sentence overall summary.",
    };

    if (!transcript) {
      return {
        ok: true,
        data: {
          ...base,
          transcriptAvailable: false,
          note: "No transcript was available (captions disabled or missing for this language). The summary must be based only on the title, channel and description, and must say so plainly. Never fabricate content.",
          description,
        },
      };
    }

    if (transcript.length <= DIRECT_LIMIT) {
      return {
        ok: true,
        data: {
          ...base,
          transcriptAvailable: true,
          transcriptLanguage,
          transcript,
        },
      };
    }

    // Long video: chunk + map-reduce so the summary covers the whole thing.
    const condensed = await condenseTranscript(title, transcript);
    if (condensed) {
      return {
        ok: true,
        data: {
          ...base,
          transcriptAvailable: true,
          transcriptLanguage,
          transcriptCondensed: true,
          transcriptChunkCount: condensed.chunkCount,
          note: `The transcript (${transcript.length} chars) was condensed chunk-by-chunk (${condensed.chunkCount} portions, whole video covered).`,
          transcriptDigest: condensed.digest,
        },
      };
    }

    // Condensing failed (e.g. summary model unreachable): return the full
    // transcript rather than silently truncating it.
    return {
      ok: true,
      data: {
        ...base,
        transcriptAvailable: true,
        transcriptLanguage,
        transcriptCondensed: false,
        note: "Chunk summarisation was unavailable; this is the FULL transcript.",
        transcript,
      },
    };
  } catch (err) {
    return {
      ok: false,
      reason: `YouTube lookup failed: ${err instanceof Error ? err.message : "unknown error"}`,
    };
  }
}
