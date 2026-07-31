import type { ToolResult } from "./index";

/**
 * LinkedIn returns a login wall to unauthenticated requests and forbids
 * scraping in its terms, so this tool never fetches linkedin.com and never
 * runs a headless browser. Profile data comes from Apollo.io's People
 * Enrichment endpoint (people/match), which accepts a LinkedIn URL directly
 * or a name + company pair.
 *
 * Privacy guard: this looks up real people. Responses are never cached to
 * disk, and the system prompt forbids the model from volunteering a lookup
 * the user did not ask for. On any failure the tool returns ok:false with
 * a plain reason — it must never invent profile data.
 */

interface ApolloEmployment {
  organization_name?: string;
  title?: string;
  start_date?: string;
  end_date?: string;
  current?: boolean;
}

interface ApolloPerson {
  name?: string;
  first_name?: string;
  last_name?: string;
  headline?: string;
  title?: string;
  city?: string;
  state?: string;
  country?: string;
  linkedin_url?: string;
  organization?: { name?: string };
  employment_history?: ApolloEmployment[];
}

export interface LinkedInLookupInput {
  url?: string;
  name?: string;
  company?: string;
}

export async function readLinkedInProfile(
  input: LinkedInLookupInput,
): Promise<ToolResult> {
  try {
    const key = process.env.APOLLO_API_KEY;
    if (!key) {
      return {
        ok: false,
        reason:
          "LinkedIn profile access is not configured (APOLLO_API_KEY is missing). Offer a clearly-labelled web search for public information instead; do not invent profile data.",
      };
    }

    const url = input.url?.trim();
    const name = input.name?.trim();
    if (url && !/linkedin\.com\/(in|company)\//i.test(url)) {
      return {
        ok: false,
        reason: "That does not look like a LinkedIn profile URL.",
      };
    }
    if (!url && !name) {
      return {
        ok: false,
        reason: "Provide a LinkedIn profile URL or a person's name (ideally with their company).",
      };
    }

    // Documented request shape (verified against docs.apollo.io): POST
    // people/match with x-api-key and query-string parameters.
    const endpoint = new URL("https://api.apollo.io/api/v1/people/match");
    if (url) {
      endpoint.searchParams.set("linkedin_url", url);
    } else if (name) {
      const parts = name.split(/\s+/);
      if (parts.length > 1) {
        endpoint.searchParams.set("first_name", parts.slice(0, -1).join(" "));
        endpoint.searchParams.set("last_name", parts[parts.length - 1]);
      } else {
        endpoint.searchParams.set("name", name);
      }
      if (input.company?.trim()) {
        endpoint.searchParams.set("organization_name", input.company.trim());
      }
    }

    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "x-api-key": key, "content-type": "application/json" },
      signal: AbortSignal.timeout(15000),
      cache: "no-store",
    });
    if (res.status === 401 || res.status === 403) {
      return { ok: false, reason: "The profile provider rejected the API key." };
    }
    if (res.status === 429) {
      return { ok: false, reason: "The profile provider's rate limit was hit. Try again shortly." };
    }
    if (!res.ok) {
      return { ok: false, reason: `The profile provider returned ${res.status}.` };
    }

    const body = (await res.json()) as { person?: ApolloPerson | null };
    const p = body.person;
    if (!p) {
      return {
        ok: false,
        reason:
          "That person is not in the profile provider's database. Offer a clearly-labelled web search for public information instead; do not invent profile data.",
      };
    }

    const history = Array.isArray(p.employment_history)
      ? p.employment_history.slice(0, 5).map((e) => ({
          title: e.title ?? null,
          company: e.organization_name ?? null,
          startDate: e.start_date ?? null,
          endDate: e.end_date ?? null,
          current: e.current ?? null,
        }))
      : [];
    const location =
      [p.city, p.state, p.country].filter(Boolean).join(", ") || null;

    return {
      ok: true,
      data: {
        name: p.name ?? [p.first_name, p.last_name].filter(Boolean).join(" ") ?? null,
        headline: p.headline ?? null,
        title: p.title ?? null,
        company: p.organization?.name ?? null,
        location,
        previousRoles: history,
        // Returned so the answer is checkable against the source.
        profileUrl: p.linkedin_url ?? url ?? null,
      },
    };
  } catch (err) {
    return {
      ok: false,
      reason: `LinkedIn lookup failed: ${err instanceof Error ? err.message : "unknown error"}`,
    };
  }
}
