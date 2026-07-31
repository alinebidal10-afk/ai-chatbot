/**
 * Transcript provider adapter. YouTube blocks caption access from
 * datacenter IPs outright (verified: even valid BotGuard PO-token sessions
 * are refused from this deployment's egress), so on a server a provider is
 * the only route to real transcript text. Written behind one interface so
 * the provider can be swapped without touching the tool.
 */

export interface TranscriptResult {
  text: string;
  language: string | null;
  /** Provider id, echoed to the model so the answer can name its source. */
  source: string;
}

export interface TranscriptProvider {
  id: string;
  configured(): boolean;
  fetch(input: {
    url: string;
    /** Preferred transcript language (ISO 639-1); falls back to whatever
     *  the video has. */
    lang?: string;
  }): Promise<
    | { ok: true; result: TranscriptResult }
    | { ok: false; reason: string; unavailable?: boolean }
  >;
}

const SUPADATA_BASE = "https://api.supadata.ai/v1";

interface SupadataTranscript {
  content?: string;
  lang?: string;
  availableLangs?: string[];
}
interface SupadataJob {
  jobId?: string;
  status?: "queued" | "active" | "completed" | "failed";
  content?: string;
  lang?: string;
  error?: { error?: string; message?: string } | null;
}
interface SupadataError {
  error?: string;
  message?: string;
  details?: string;
}

/** Long videos come back as a job; poll briefly rather than giving up. */
const JOB_POLL_MS = 1500;
const JOB_MAX_WAIT_MS = 25000;

const supadata: TranscriptProvider = {
  id: "supadata",
  configured: () => Boolean(process.env.SUPADATA_API_KEY),
  async fetch({ url, lang }) {
    const key = process.env.SUPADATA_API_KEY;
    if (!key) return { ok: false, reason: "not configured" };

    const query = new URLSearchParams({ url, text: "true", mode: "native" });
    // Without a preference the API returns whichever track is first, which
    // is often a translation rather than the spoken language.
    if (lang) query.set("lang", lang);

    try {
      const res = await fetch(`${SUPADATA_BASE}/transcript?${query}`, {
        headers: { "x-api-key": key },
        signal: AbortSignal.timeout(30000),
      });
      const body = (await res.json().catch(() => null)) as
        | (SupadataTranscript & SupadataJob & SupadataError)
        | null;

      if (!res.ok || !body) {
        const code = body?.error ?? `http-${res.status}`;
        // A missing transcript is a fact about the video, not a failure of
        // the lookup — the tool reports it honestly rather than retrying.
        const unavailable =
          code === "transcript-unavailable" || code === "not-found";
        return {
          ok: false,
          reason: body?.message ? `${code}: ${body.message}` : code,
          unavailable,
        };
      }

      if (typeof body.content === "string" && body.content.trim()) {
        return {
          ok: true,
          result: {
            text: body.content.replace(/\s+/g, " ").trim(),
            language: body.lang ?? null,
            source: "supadata",
          },
        };
      }

      // Asynchronous path: poll the job until it completes.
      if (body.jobId) {
        const deadline = Date.now() + JOB_MAX_WAIT_MS;
        while (Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, JOB_POLL_MS));
          const jobRes = await fetch(
            `${SUPADATA_BASE}/transcript/${body.jobId}`,
            { headers: { "x-api-key": key }, signal: AbortSignal.timeout(15000) },
          );
          const job = (await jobRes.json().catch(() => null)) as SupadataJob | null;
          if (!job) continue;
          if (job.status === "failed") {
            return {
              ok: false,
              reason: job.error?.message ?? "transcript job failed",
              unavailable: job.error?.error === "transcript-unavailable",
            };
          }
          if (job.status === "completed" && typeof job.content === "string") {
            return {
              ok: true,
              result: {
                text: job.content.replace(/\s+/g, " ").trim(),
                language: job.lang ?? null,
                source: "supadata",
              },
            };
          }
        }
        return { ok: false, reason: "transcript job still running" };
      }

      return { ok: false, reason: "empty transcript response" };
    } catch (err) {
      return {
        ok: false,
        reason: err instanceof Error ? err.message : "provider request failed",
      };
    }
  },
};

const PROVIDERS: TranscriptProvider[] = [supadata];

/** First configured provider, or null when none has credentials. */
export function getTranscriptProvider(): TranscriptProvider | null {
  return PROVIDERS.find((p) => p.configured()) ?? null;
}
