import type { ToolResult } from "./index";

/**
 * YouTube metadata + transcripts via the InnerTube player API (ANDROID
 * client). The plain web watch-page caption URLs return empty bodies
 * without a proof-of-origin token; the Android client's URLs still work.
 */

const ANDROID_UA =
  "com.google.android.youtube/20.10.38 (Linux; U; Android 11) gzip";
const MAX_TRANSCRIPT_CHARS = 24000;

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

interface CaptionTrack {
  baseUrl: string;
  languageCode?: string;
  kind?: string;
}

interface PlayerData {
  playabilityStatus?: { status?: string; reason?: string };
  videoDetails?: {
    title?: string;
    author?: string;
    shortDescription?: string;
  };
  captions?: {
    playerCaptionsTracklistRenderer?: { captionTracks?: CaptionTrack[] };
  };
}

async function fetchPlayer(videoId: string): Promise<PlayerData | null> {
  try {
    const res = await fetch("https://www.youtube.com/youtubei/v1/player", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "user-agent": ANDROID_UA,
      },
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
    return (await res.json()) as PlayerData;
  } catch {
    return null;
  }
}

function pickTrack(tracks: CaptionTrack[]): CaptionTrack | null {
  if (tracks.length === 0) return null;
  // Prefer human captions, then English, then anything (auto-generated ok)
  const human = tracks.filter((t) => t.kind !== "asr");
  const pool = human.length > 0 ? human : tracks;
  return pool.find((t) => t.languageCode?.startsWith("en")) ?? pool[0];
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&#0?39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

async function fetchTranscript(track: CaptionTrack): Promise<string | null> {
  try {
    const url = track.baseUrl.includes("fmt=")
      ? track.baseUrl
      : `${track.baseUrl}&fmt=json3`;
    const res = await fetch(url, {
      headers: { "user-agent": ANDROID_UA },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return null;
    const body = await res.text();
    // json3 format
    try {
      const doc = JSON.parse(body) as {
        events?: { segs?: { utf8?: string }[] }[];
      };
      if (doc.events) {
        const text = doc.events
          .flatMap((e) => e.segs ?? [])
          .map((s) => s.utf8 ?? "")
          .join("")
          .replace(/\s+/g, " ")
          .trim();
        return text || null;
      }
    } catch {
      /* fall through to XML */
    }
    // timedtext XML: <text ...>…</text> (srv1) or <p ...>…</p> (format 3)
    const texts = [
      ...body.matchAll(/<(?:text|p)\b[^>]*>([\s\S]*?)<\/(?:text|p)>/g),
    ].map((m) => decodeEntities(m[1].replace(/<[^>]+>/g, " ")));
    const text = texts.join(" ").replace(/\s+/g, " ").trim();
    return text || null;
  } catch {
    return null;
  }
}

/** Evenly sample a long transcript so the summary still covers the whole video. */
function sampleTranscript(text: string): { text: string; truncated: boolean } {
  if (text.length <= MAX_TRANSCRIPT_CHARS) return { text, truncated: false };
  const chunk = Math.floor(MAX_TRANSCRIPT_CHARS / 3);
  const mid = Math.floor(text.length / 2 - chunk / 2);
  const parts = [
    text.slice(0, chunk),
    text.slice(mid, mid + chunk),
    text.slice(-chunk),
  ];
  return {
    text: parts.join("\n[... transcript sampled: gap ...]\n"),
    truncated: true,
  };
}

async function fetchOembedTitle(videoId: string) {
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

export async function summarizeYoutube(url: string): Promise<ToolResult> {
  try {
    const videoId = extractVideoId(url);
    if (!videoId) {
      return { ok: false, reason: "Could not extract a video ID from that URL." };
    }

    const player = await fetchPlayer(videoId);
    const details = player?.videoDetails;
    let title = details?.title ?? null;
    let channel = details?.author ?? null;
    const description = details?.shortDescription?.slice(0, 1500) ?? null;

    if (!title) {
      const oembed = await fetchOembedTitle(videoId);
      title = oembed?.title ?? null;
      channel = channel ?? oembed?.author_name ?? null;
    }
    if (!title) {
      return {
        ok: false,
        reason: "The video does not exist, is private, or YouTube is unreachable.",
      };
    }

    const status = player?.playabilityStatus?.status;
    if (status && status !== "OK") {
      return {
        ok: true,
        data: {
          videoId,
          title,
          channel,
          transcriptAvailable: false,
          note: `The video is not publicly playable (${player?.playabilityStatus?.reason ?? status}), so no transcript is available. Any summary must be limited to the title/channel/description and must say so clearly.`,
          description,
        },
      };
    }

    const tracks =
      player?.captions?.playerCaptionsTracklistRenderer?.captionTracks ?? [];
    const track = pickTrack(tracks);
    const transcript = track ? await fetchTranscript(track) : null;

    if (!transcript) {
      return {
        ok: true,
        data: {
          videoId,
          title,
          channel,
          transcriptAvailable: false,
          note: "No transcript was available. Any summary must be limited to the title, channel and description, and must say so clearly.",
          description,
        },
      };
    }

    const sampled = sampleTranscript(transcript);
    return {
      ok: true,
      data: {
        videoId,
        title,
        channel,
        transcriptAvailable: true,
        transcriptLanguage: track?.languageCode ?? null,
        transcriptSampled: sampled.truncated,
        transcript: sampled.text,
      },
    };
  } catch (err) {
    return {
      ok: false,
      reason: `YouTube lookup failed: ${err instanceof Error ? err.message : "unknown error"}`,
    };
  }
}
