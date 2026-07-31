import { Innertube } from "youtubei.js";
import { getClient } from "@/lib/providers/anthropic";
import { getPotSession } from "./youtube-pot";
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
  if (!_yt) {
    _yt = Innertube.create();
    // A transient failure must not poison the cache for every later call.
    _yt.catch(() => {
      _yt = null;
    });
  }
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

    const text = parseCaptionBody(body);
    return text ? { text, language: track.languageCode ?? null } : null;
  } catch {
    return null;
  }
}

/** Caption payload to plain text: json3 first, timedtext XML as fallback. */
function parseCaptionBody(body: string): string {
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
    text = [...body.matchAll(/<(?:text|p)\b[^>]*>([\s\S]*?)<\/(?:text|p)>/g)]
      .map((m) => decodeEntities(m[1].replace(/<[^>]+>/g, " ")))
      .join(" ");
  }
  return text.replace(/\s+/g, " ").trim();
}

/**
 * Metadata straight from the watch page's embedded videoDetails. Works even
 * where the InnerTube API answers LOGIN_REQUIRED ("confirm you're not a
 * bot") for datacenter IPs — the page itself is still served with title,
 * channel, duration and description, just without caption tracks.
 */
export async function fetchWatchPageMeta(videoId: string): Promise<{
  title: string;
  author: string | null;
  lengthSeconds: number | null;
  shortDescription: string | null;
} | null> {
  try {
    const res = await fetch(`https://www.youtube.com/watch?v=${videoId}`, {
      headers: {
        "user-agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36",
        "accept-language": "en-US,en;q=0.9",
        cookie: "CONSENT=YES+1",
      },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return null;
    const html = await res.text();
    // The page contains several "videoDetails" objects (e.g. the embedded
    // player overlay's). The player response's one starts with our videoId.
    const at = html.indexOf(`"videoDetails":{"videoId":"${videoId}"`);
    if (at === -1) return null;
    const scope = html.slice(at, at + 30000);
    const unescape = (s: string): string => {
      try {
        return JSON.parse(`"${s}"`) as string;
      } catch {
        return s;
      }
    };
    const field = (name: string): string | null => {
      const m = scope.match(new RegExp(`"${name}":"((?:[^"\\\\]|\\\\.)*)"`));
      return m ? unescape(m[1]) : null;
    };
    const title = field("title");
    if (!title) return null;
    const length = scope.match(/"lengthSeconds":"(\d+)"/);
    return {
      title,
      author: field("author"),
      lengthSeconds: length ? Number(length[1]) : null,
      shortDescription: field("shortDescription")?.slice(0, 1500) ?? null,
    };
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
    // YouTube answers LOGIN_REQUIRED ("confirm you're not a bot") to the
    // InnerTube API from datacenter IPs. Crucially getInfo does NOT throw
    // for it — it "succeeds" with empty basic_info — so it must be detected
    // explicitly or every fallback below is silently skipped.
    let accessBlocked = false;

    try {
      const yt = await getInnertube();
      const info = await yt.getInfo(videoId);
      accessBlocked = info.playability_status?.status === "LOGIN_REQUIRED";
      title = info.basic_info.title ?? null;
      channel = info.basic_info.author ?? null;
      durationSeconds = info.basic_info.duration ?? null;
      description = info.basic_info.short_description?.slice(0, 1500) ?? null;

      if (!accessBlocked) {
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
          // get_transcript can 400 while caption tracks still exist — try
          // the raw ANDROID caption path before concluding no captions.
          const fallback = await fetchTranscriptViaAndroid(videoId);
          if (fallback) {
            transcript = fallback.text;
            transcriptLanguage = fallback.language;
          }
        }
      }
    } catch {
      // Innertube itself failed — caption state is unknown, so the note
      // below must say "could not be retrieved", not "captions disabled".
      accessBlocked = true;
    }

    if (accessBlocked) {
      // Bot-walled network: run a BotGuard attestation and retry with a
      // PO-token session — the sanctioned way past "confirm you're not a
      // bot" for automated WEB-client requests.
      const pot = await getPotSession();
      if (pot) {
        try {
          const info = await pot.innertube.getInfo(videoId);
          if (info.playability_status?.status !== "LOGIN_REQUIRED") {
            accessBlocked = false;
            title = info.basic_info.title ?? title;
            channel = info.basic_info.author ?? channel;
            durationSeconds = info.basic_info.duration ?? durationSeconds;
            description =
              info.basic_info.short_description?.slice(0, 1500) ?? description;

            try {
              const t = await info.getTranscript();
              transcriptLanguage = t.selectedLanguage ?? null;
              const segments =
                t.transcript?.content?.body?.initial_segments ?? [];
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
              // Caption URLs from this player response need a CONTENT-bound
              // token appended, or they come back empty.
              const tracks = info.captions?.caption_tracks ?? [];
              const human = tracks.filter((t) => t.kind !== "asr");
              const pool = human.length > 0 ? human : tracks;
              const track =
                pool.find((t) => t.language_code?.startsWith("en")) ?? pool[0];
              if (track) {
                const contentPot = await pot.mintContentToken(videoId);
                const sep = track.base_url.includes("?") ? "&" : "?";
                const body = await fetch(
                  `${track.base_url}${sep}fmt=json3&pot=${contentPot}&c=WEB`,
                  { signal: AbortSignal.timeout(10000) },
                ).then((r) => (r.ok ? r.text() : ""));
                const text = body ? parseCaptionBody(body) : "";
                if (text) {
                  transcript = text;
                  transcriptLanguage = track.language_code ?? null;
                }
              }
            }
          }
        } catch {
          /* still blocked — the honest metadata path below handles it */
        }
      }
    }

    if (!title) {
      // The watch page is served even where the API is bot-walled, and its
      // videoDetails carry title, channel, duration and description.
      const page = await fetchWatchPageMeta(videoId);
      if (page) {
        title = page.title;
        channel = page.author;
        durationSeconds = page.lengthSeconds;
        description = page.shortDescription;
      }
    }
    if (!title) {
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
          note: accessBlocked
            ? "The transcript could not be retrieved: YouTube refused automated caption access from this server (bot check or lookup failure). Captions may well exist on the video. The summary must be based only on the title, channel and description, must say plainly that the transcript was not accessible, and must never fabricate content."
            : "No transcript was available (captions disabled or missing for this language). The summary must be based only on the title, channel and description, and must say so plainly. Never fabricate content.",
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
