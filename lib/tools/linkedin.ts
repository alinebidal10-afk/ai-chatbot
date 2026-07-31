import type { ToolResult } from "./index";

/**
 * LinkedIn returns a login wall to unauthenticated requests and forbids
 * scraping in its terms, so this tool never fetches linkedin.com and never
 * runs a headless browser. Three layers, tried in order, so the tool
 * degrades instead of failing outright:
 *
 *   1. Apollo.io People Enrichment (people/match) — richest data.
 *   2. Public search results — LinkedIn result titles carry
 *      "Name - Headline - Company | LinkedIn"; clearly labelled as search.
 *   3. Honest failure — ok:false, never invented data.
 *
 * Privacy guard: real people. Responses are never cached to disk, and the
 * system prompt forbids volunteering a lookup the user did not ask for.
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

type ApolloOutcome =
  | { kind: "person"; person: ApolloPerson }
  | { kind: "not-found" }
  | { kind: "unavailable"; detail: string };

/** Layer 1. Surfaces the real HTTP status and body — a generic message
 *  hides the difference between a plan problem and a missing person. */
async function apolloLookup(input: LinkedInLookupInput): Promise<ApolloOutcome> {
  const key = process.env.APOLLO_API_KEY;
  if (!key) {
    return { kind: "unavailable", detail: "APOLLO_API_KEY is not configured." };
  }

  const endpoint = new URL("https://api.apollo.io/api/v1/people/match");
  if (input.url) {
    endpoint.searchParams.set("linkedin_url", input.url);
  } else if (input.name) {
    const parts = input.name.split(/\s+/);
    if (parts.length > 1) {
      endpoint.searchParams.set("first_name", parts.slice(0, -1).join(" "));
      endpoint.searchParams.set("last_name", parts[parts.length - 1]);
    } else {
      endpoint.searchParams.set("name", input.name);
    }
    if (input.company?.trim()) {
      endpoint.searchParams.set("organization_name", input.company.trim());
    }
  }

  let res: Response;
  try {
    res = await fetch(endpoint, {
      method: "POST",
      headers: { "x-api-key": key, "content-type": "application/json" },
      signal: AbortSignal.timeout(15000),
      cache: "no-store",
    });
  } catch (err) {
    return {
      kind: "unavailable",
      detail: `Apollo request failed before a response: ${err instanceof Error ? err.message : "unknown"} (network restriction, not auth).`,
    };
  }

  if (!res.ok) {
    const body = (await res.text().catch(() => "")).slice(0, 300);
    console.error(`[linkedin] Apollo ${res.status}: ${body}`);
    const hint =
      res.status === 401 || res.status === 403
        ? "The key is missing, wrong, or the plan does not include API enrichment (needs a master key from Settings > Integrations > API)."
        : res.status === 422
          ? "The request shape was rejected — field names may have changed; check Apollo's current docs."
          : res.status === 429
            ? "Rate limited — retry with backoff."
            : "Unexpected provider error.";
    return {
      kind: "unavailable",
      detail: `Apollo returned HTTP ${res.status}. ${hint} Response body: ${body || "(empty)"}`,
    };
  }

  const data = (await res.json().catch(() => null)) as {
    person?: ApolloPerson | null;
  } | null;
  // 200 with an empty person is the COMMON case, not an error: Apollo's
  // B2B coverage misses students and most people outside that world.
  if (!data?.person) return { kind: "not-found" };
  return { kind: "person", person: data.person };
}

/** Layer 2: public search results (DuckDuckGo's HTML endpoint, keyless).
 *  Public LinkedIn profiles are indexed and the result title alone carries
 *  "Name - Headline - Company | LinkedIn". */
async function publicSearchLookup(
  input: LinkedInLookupInput,
): Promise<{ title: string; url: string; snippet: string } | null> {
  const queries: string[] = [];
  const handle = input.url?.match(/linkedin\.com\/in\/([^/?#]+)/i)?.[1];
  if (handle) {
    queries.push(`linkedin.com/in/${handle}`);
    queries.push(`"${handle}" LinkedIn profile`);
  }
  if (input.name) {
    queries.push(
      `"${input.name}"${input.company ? ` "${input.company}"` : ""} site:linkedin.com`,
    );
  }

  // The html endpoint throttles bursts with an empty 202 page; the lite
  // endpoint sits in a different bucket and uses the same uddg wrapping.
  const engines = [
    (q: string) => `https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}`,
    (q: string) => `https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(q)}`,
  ];

  for (const q of queries) {
    for (const engine of engines) {
      const html = await fetchSearchPage(engine(q));
      if (!html) continue;

      // Both endpoints wrap result links as /l/?uddg=<encoded>. Take every
      // anchor, then keep the first that resolves to a LinkedIn profile.
      const anchors = [
        ...html.matchAll(/<a[^>]+href="([^"]*uddg=[^"]+)"[^>]*>([\s\S]*?)<\/a>/g),
      ].map((m) => ({
        url: decodeDdgHref(m[1]),
        title: m[2].replace(/<[^>]+>/g, "").trim(),
      }));
      const snippets = [
        ...html.matchAll(
          /class="result__snippet"[^>]*>([\s\S]*?)<\/a>|<td[^>]+class='result-snippet'[^>]*>([\s\S]*?)<\/td>/g,
        ),
      ].map((m) => (m[1] ?? m[2] ?? "").replace(/<[^>]+>/g, "").trim());

      const hit = anchors.find(
        (a) => /linkedin\.com\/(in|company)\//i.test(a.url) && a.title,
      );
      if (hit) {
        const snippet =
          snippets.find((s) => s.length > 40) ?? snippets[0] ?? "";
        return { title: hit.title, url: hit.url, snippet };
      }
      // A real results page without a LinkedIn hit answers the query —
      // move to the next query instead of hammering the other endpoint.
      if (anchors.length > 0) break;
    }
  }
  return null;
}

async function fetchSearchPage(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, {
      headers: {
        "user-agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
      },
      signal: AbortSignal.timeout(10000),
    });
    // A 202 is the throttle page — no results in it.
    if (!res.ok || res.status === 202) return null;
    return await res.text();
  } catch {
    return null;
  }
}

function decodeDdgHref(href: string): string {
  // DDG wraps result URLs as /l/?uddg=<encoded>
  const m = href.match(/[?&]uddg=([^&]+)/);
  if (m) {
    try {
      return decodeURIComponent(m[1]);
    } catch {
      return href;
    }
  }
  return href;
}

/** "Name - Headline - Company | LinkedIn" -> parts */
function parseSearchTitle(title: string): {
  name: string | null;
  headline: string | null;
  company: string | null;
} {
  const cleaned = title.replace(/\s*\|\s*LinkedIn\s*$/i, "").trim();
  const parts = cleaned.split(/\s+[-–—]\s+/).map((p) => p.trim());
  return {
    name: parts[0] || null,
    headline: parts[1] || null,
    company: parts[2] || null,
  };
}

export async function readLinkedInProfile(
  input: LinkedInLookupInput,
): Promise<ToolResult> {
  try {
    const url = input.url?.trim();
    const name = input.name?.trim();
    if (url && !/linkedin\.com\/(in|company)\//i.test(url)) {
      return { ok: false, reason: "That does not look like a LinkedIn profile URL." };
    }
    if (!url && !name) {
      return {
        ok: false,
        reason: "Provide a LinkedIn profile URL or a person's name (ideally with their company).",
      };
    }
    const cleanInput: LinkedInLookupInput = { url, name, company: input.company };

    // Layer 1: Apollo enrichment
    const apollo = await apolloLookup(cleanInput);
    if (apollo.kind === "person") {
      const p = apollo.person;
      const history = Array.isArray(p.employment_history)
        ? p.employment_history.slice(0, 5).map((e) => ({
            title: e.title ?? null,
            company: e.organization_name ?? null,
            startDate: e.start_date ?? null,
            endDate: e.end_date ?? null,
            current: e.current ?? null,
          }))
        : [];
      return {
        ok: true,
        data: {
          source: "provider",
          name: p.name ?? [p.first_name, p.last_name].filter(Boolean).join(" ") ?? null,
          headline: p.headline ?? null,
          title: p.title ?? null,
          company: p.organization?.name ?? null,
          location: [p.city, p.state, p.country].filter(Boolean).join(", ") || null,
          previousRoles: history,
          profileUrl: p.linkedin_url ?? url ?? null,
        },
      };
    }

    // Layer 2: public search results (clearly labelled as such)
    const search = await publicSearchLookup(cleanInput);
    if (search) {
      const parsed = parseSearchTitle(search.title);
      return {
        ok: true,
        data: {
          source: "public-search",
          note:
            "This comes from PUBLIC SEARCH RESULTS, not from LinkedIn itself" +
            (apollo.kind === "unavailable"
              ? ` (the enrichment provider was unavailable: ${apollo.detail})`
              : " (the person is not in the enrichment provider's database)") +
            ". Present it as search-derived and cite the profile URL.",
          name: parsed.name,
          headline: parsed.headline,
          company: parsed.company,
          resultTitle: search.title,
          resultSnippet: search.snippet.slice(0, 400),
          profileUrl: search.url,
        },
      };
    }

    // Layer 3: honest failure — never invent
    return {
      ok: false,
      reason:
        apollo.kind === "unavailable"
          ? `No profile data available. ${apollo.detail} Public search also returned nothing usable. Do not invent profile data.`
          : "That person is not in the enrichment provider's database and public search returned nothing usable. Do not invent profile data.",
    };
  } catch (err) {
    return {
      ok: false,
      reason: `LinkedIn lookup failed: ${err instanceof Error ? err.message : "unknown error"}`,
    };
  }
}
