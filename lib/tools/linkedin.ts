import type { ToolResult } from "./index";

/**
 * LinkedIn blocks unauthenticated requests and forbids scraping in its terms
 * of service, so this tool never scrapes. It only works when a profile-data
 * provider key is configured (PROFILE_API_KEY, Proxycurl-compatible);
 * otherwise it admits it cannot help. It must never invent profile data.
 */
export async function readLinkedInProfile(url: string): Promise<ToolResult> {
  try {
    const key = process.env.PROFILE_API_KEY;
    if (!key) {
      return { ok: false, reason: "LinkedIn profile access is not configured" };
    }
    if (!/linkedin\.com\/(in|company)\//i.test(url)) {
      return { ok: false, reason: "That does not look like a LinkedIn profile URL." };
    }
    const endpoint = new URL("https://nubela.co/proxycurl/api/v2/linkedin");
    endpoint.searchParams.set("url", url);
    const res = await fetch(endpoint, {
      headers: { authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) {
      return {
        ok: false,
        reason: `The profile provider returned ${res.status}. The profile may be private or the provider quota exhausted.`,
      };
    }
    const p = (await res.json()) as Record<string, unknown>;
    const experiences = Array.isArray(p.experiences)
      ? (p.experiences as Record<string, unknown>[]).slice(0, 5).map((e) => ({
          title: e.title ?? null,
          company: e.company ?? null,
          startsAt: e.starts_at ?? null,
          endsAt: e.ends_at ?? null,
        }))
      : [];
    return {
      ok: true,
      data: {
        name: [p.first_name, p.last_name].filter(Boolean).join(" ") || null,
        headline: p.headline ?? null,
        company: experiences[0]?.company ?? null,
        experience: experiences,
      },
    };
  } catch (err) {
    return {
      ok: false,
      reason: `LinkedIn lookup failed: ${err instanceof Error ? err.message : "unknown error"}`,
    };
  }
}
