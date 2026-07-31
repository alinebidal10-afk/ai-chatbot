import { getClient } from "@/lib/providers/anthropic";
import type { ToolResult } from "./index";

/**
 * LinkedIn's own API cannot read arbitrary profiles and direct fetching hits
 * a login wall (and is forbidden by LinkedIn's terms) — this tool never
 * fetches linkedin.com and never runs a headless browser. Two sources, both
 * used, in order:
 *
 *   Path A — a profile data provider, behind the ProfileProvider interface
 *            so the provider can be swapped without touching anything else.
 *            Current adapter: Apollo.io people/match.
 *   Path B — the public search index, via the Anthropic API's server-side
 *            web search tool. Public profile titles carry
 *            "Name - Headline - Company | LinkedIn".
 *
 * Results are normalised into one Profile shape; when both paths return
 * data they are merged (provider fields win, search fills gaps) and both
 * appear in `sources`. Never fabricate; on ambiguity, list the candidates.
 *
 * Privacy guard: real people. No responses are cached to disk, and the
 * system prompt forbids volunteering a lookup the user did not ask for.
 */

export interface LinkedInLookupInput {
  url?: string;
  name?: string;
  company?: string;
}

interface Profile {
  fullName: string | null;
  headline?: string | null;
  currentTitle?: string | null;
  currentCompany?: string | null;
  location?: string | null;
  about?: string | null;
  experience?: { title: string | null; company: string | null; dates?: string | null }[];
  education?: { school: string | null; degree?: string | null; dates?: string | null }[];
  profileUrl: string | null;
  sources: string[];
}

// ---------------------------------------------------------------------------
// Path A — profile data provider behind a swappable adapter
// ---------------------------------------------------------------------------

type ProviderOutcome =
  | { kind: "profile"; profile: Profile }
  | { kind: "not-found" }
  | { kind: "unavailable"; detail: string };

interface ProfileProvider {
  id: string;
  configured(): boolean;
  fetch(input: LinkedInLookupInput): Promise<ProviderOutcome>;
}

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

/** Apollo.io people/match adapter. Surfaces the real HTTP status and body —
 *  the status distinguishes a plan problem from a missing person. */
const apolloProvider: ProfileProvider = {
  id: "apollo",
  configured: () => Boolean(process.env.APOLLO_API_KEY),
  async fetch(input) {
    const key = process.env.APOLLO_API_KEY;
    if (!key) return { kind: "unavailable", detail: "APOLLO_API_KEY is not configured." };

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

    const data = (await res.json().catch(() => null)) as { person?: ApolloPerson | null } | null;
    // 200 with an empty person is the COMMON case, not an error: Apollo's
    // B2B coverage misses students and most people outside that world.
    const p = data?.person;
    if (!p) return { kind: "not-found" };

    const experience = Array.isArray(p.employment_history)
      ? p.employment_history.slice(0, 6).map((e) => ({
          title: e.title ?? null,
          company: e.organization_name ?? null,
          dates: [e.start_date, e.current ? "present" : e.end_date].filter(Boolean).join(" - ") || null,
        }))
      : [];
    return {
      kind: "profile",
      profile: {
        fullName: p.name ?? [p.first_name, p.last_name].filter(Boolean).join(" ") ?? null,
        headline: p.headline ?? null,
        currentTitle: p.title ?? null,
        currentCompany: p.organization?.name ?? null,
        location: [p.city, p.state, p.country].filter(Boolean).join(", ") || null,
        experience,
        profileUrl: p.linkedin_url ?? input.url ?? null,
        sources: ["apollo"],
      },
    };
  },
};

// ---------------------------------------------------------------------------
// Scrapin adapter (Scrapin is now ReverseContact — V2 API, rc_ keys).
// Verified against https://api.reversecontact.com/openapi.json:
//   POST /v2/fetch/persons        {url}  -> sync, data: PersonFull
//   POST /v2/resolve/persons/name {firstName,lastName,companyName} -> async
//     JobAck {webhookId}; poll GET /v2/webhooks/{id} until succeeded/errored
//   Auth: Authorization: Bearer rc_...
// ---------------------------------------------------------------------------

const SCRAPIN_BASE = "https://api.reversecontact.com";

interface ScrapinPerson {
  linkedinUrl?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  headline?: string | null;
  summary?: string | null;
  location?: {
    city?: string | null;
    state?: string | null;
    country?: string | null;
  } | null;
  currentPosition?: {
    title?: string | null;
    companyName?: string | null;
  } | null;
  experience?: {
    title?: string | null;
    companyName?: string | null;
    startEndDate?: unknown;
  }[];
  education?: {
    schoolName?: string | null;
    degreeName?: string | null;
    fieldOfStudy?: string | null;
    startEndDate?: unknown;
  }[];
}

function scrapinDates(range: unknown): string | null {
  if (!range || typeof range !== "object") return null;
  const r = range as { start?: unknown; end?: unknown };
  const fmt = (d: unknown) => {
    if (!d || typeof d !== "object") return null;
    const { month, year } = d as { month?: number; year?: number };
    return year ? `${month ? `${month}/` : ""}${year}` : null;
  };
  const start = fmt(r.start);
  const end = fmt(r.end) ?? (start ? "present" : null);
  return start ? `${start} - ${end}` : null;
}

function scrapinToProfile(p: ScrapinPerson, inputUrl?: string): Profile {
  return {
    fullName: [p.firstName, p.lastName].filter(Boolean).join(" ") || null,
    headline: p.headline ?? null,
    currentTitle: p.currentPosition?.title ?? null,
    currentCompany: p.currentPosition?.companyName ?? null,
    location:
      [p.location?.city, p.location?.state, p.location?.country]
        .filter(Boolean)
        .join(", ") || null,
    about: p.summary ?? null,
    experience: (p.experience ?? []).slice(0, 6).map((e) => ({
      title: e.title ?? null,
      company: e.companyName ?? null,
      dates: scrapinDates(e.startEndDate),
    })),
    education: (p.education ?? []).slice(0, 4).map((e) => ({
      school: e.schoolName ?? null,
      degree: [e.degreeName, e.fieldOfStudy].filter(Boolean).join(", ") || null,
      dates: scrapinDates(e.startEndDate),
    })),
    profileUrl: p.linkedinUrl ?? inputUrl ?? null,
    sources: ["scrapin"],
  };
}

async function scrapinRequest(
  key: string,
  path: string,
  body?: Record<string, unknown>,
): Promise<
  | { ok: true; envelope: { success?: boolean; data?: unknown; error?: { code?: string; message?: string } | null } }
  | { ok: false; detail: string }
> {
  let res: Response;
  try {
    res = await fetch(`${SCRAPIN_BASE}${path}`, {
      method: body ? "POST" : "GET",
      headers: {
        authorization: `Bearer ${key}`,
        ...(body ? { "content-type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(20000),
      cache: "no-store",
    });
  } catch (err) {
    return {
      ok: false,
      detail: `Scrapin request failed before a response: ${err instanceof Error ? err.message : "unknown"} (network restriction, not auth).`,
    };
  }
  const envelope = (await res.json().catch(() => null)) as
    | { success?: boolean; data?: unknown; error?: { code?: string; message?: string } | null }
    | null;
  if (!res.ok || !envelope) {
    // "Person not found in database" arrives as an HTTP 404 error envelope
    // (no credits consumed) — that is the common miss, not a provider fault.
    if (envelope && /not found/i.test(envelope.error?.message ?? "")) {
      return { ok: true, envelope };
    }
    const hint =
      res.status === 401 || res.status === 403
        ? "The key is missing, wrong, or the plan does not include this endpoint."
        : res.status === 402
          ? "Out of credits."
          : res.status === 429
            ? "Rate limited — retry with backoff."
            : "Unexpected provider error.";
    console.error(`[linkedin] Scrapin ${res.status} on ${path}: ${JSON.stringify(envelope)?.slice(0, 200)}`);
    return { ok: false, detail: `Scrapin returned HTTP ${res.status}. ${hint}` };
  }
  return { ok: true, envelope };
}

const scrapinProvider: ProfileProvider = {
  id: "scrapin",
  configured: () => Boolean(process.env.SCRAPIN_API_KEY),
  async fetch(input) {
    const key = process.env.SCRAPIN_API_KEY;
    if (!key) return { kind: "unavailable", detail: "SCRAPIN_API_KEY is not configured." };

    // URL input: synchronous fetch
    if (input.url) {
      const res = await scrapinRequest(key, "/v2/fetch/persons", { url: input.url });
      if (!res.ok) return { kind: "unavailable", detail: res.detail };
      if (!res.envelope.success || !res.envelope.data) {
        const code = res.envelope.error?.code ?? "";
        const message = res.envelope.error?.message ?? "";
        if (/NOT_FOUND/i.test(code) || /not found/i.test(message)) {
          return { kind: "not-found" };
        }
        return {
          kind: "unavailable",
          detail: `Scrapin error ${code || "unknown"}: ${message || "no message"}`,
        };
      }
      return { kind: "profile", profile: scrapinToProfile(res.envelope.data as ScrapinPerson, input.url) };
    }

    // Name input: async resolve + short poll. Requires a company.
    if (!input.name) return { kind: "not-found" };
    if (!input.company?.trim()) {
      return {
        kind: "unavailable",
        detail: "Scrapin name resolution needs a company name alongside the person's name.",
      };
    }
    const parts = input.name.split(/\s+/);
    const ack = await scrapinRequest(key, "/v2/resolve/persons/name", {
      firstName: parts.slice(0, -1).join(" ") || parts[0],
      lastName: parts[parts.length - 1],
      companyName: input.company.trim(),
    });
    if (!ack.ok) return { kind: "unavailable", detail: ack.detail };
    const webhookId = (ack.envelope.data as { webhookId?: string } | undefined)?.webhookId;
    if (!ack.envelope.success || !webhookId) {
      return {
        kind: "unavailable",
        detail: `Scrapin resolve did not return a job id: ${JSON.stringify(ack.envelope.error) ?? "unknown"}`,
      };
    }

    // Poll the async job for up to ~20s.
    for (let i = 0; i < 10; i++) {
      await new Promise((r) => setTimeout(r, 2000));
      const poll = await scrapinRequest(key, `/v2/webhooks/${webhookId}`);
      if (!poll.ok) return { kind: "unavailable", detail: poll.detail };
      const job = poll.envelope.data as
        | { status?: string; data?: unknown; errorCode?: string | null }
        | undefined;
      if (job?.status === "succeeded") {
        if (!job.data) return { kind: "not-found" };
        // The resolve payload nests the person; accept either shape.
        const person = ((job.data as { person?: ScrapinPerson }).person ?? job.data) as ScrapinPerson;
        return { kind: "profile", profile: scrapinToProfile(person) };
      }
      if (job?.status === "errored") {
        if (/NOT_FOUND/i.test(job.errorCode ?? "")) return { kind: "not-found" };
        return { kind: "unavailable", detail: `Scrapin resolve job errored: ${job.errorCode ?? "unknown"}` };
      }
    }
    return { kind: "unavailable", detail: "Scrapin resolve job did not finish within 20s." };
  },
};

// Provider selection: first configured adapter wins; Scrapin is preferred.
const PROVIDERS: ProfileProvider[] = [scrapinProvider, apolloProvider];
function currentProvider(): ProfileProvider {
  return PROVIDERS.find((p) => p.configured()) ?? PROVIDERS[0];
}

// ---------------------------------------------------------------------------
// Path B — public search index via the Anthropic server-side web search tool
// ---------------------------------------------------------------------------

const SEARCH_MODEL = "claude-haiku-4-5";

interface SearchLookupResult {
  found: boolean;
  ambiguous?: boolean;
  candidates?: { name?: string; distinguishedBy?: string }[];
  profile?: Profile;
}

/** LinkedIn allows search engines to index public profile titles and meta
 *  descriptions even though the page itself is walled. A small model with
 *  the server-side web_search tool runs targeted queries and extracts the
 *  fields — strictly from search results, never invented. */
async function webSearchLookup(
  input: LinkedInLookupInput,
): Promise<SearchLookupResult | null> {
  const target = input.url
    ? `the LinkedIn profile at ${input.url}`
    : `the LinkedIn profile of "${input.name}"${input.company ? ` who works at "${input.company}"` : ""}`;

  const instructions = input.url
    ? `Search for this exact URL first: ${input.url} — then run one broader search on the person's name (from the URL handle or the results).`
    : `Search: site:linkedin.com/in "${input.name}"${input.company ? ` "${input.company}"` : ""} — then run one broader search on "${input.name}" to pick up publicly reported roles from other sources.`;

  try {
    const response = await getClient().messages.create({
      model: SEARCH_MODEL,
      max_tokens: 1024,
      tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 4 }],
      system: `You look up LinkedIn profile facts from PUBLIC SEARCH RESULTS only. Public profile result titles follow "Name - Headline - Company | LinkedIn"; snippets often carry the location. Use only what the search results state - never guess or fill gaps from general knowledge. If several different people match, do not pick one.

Reply with STRICT JSON only (no prose, no code fences), exactly one of:
{"found":true,"ambiguous":false,"profile":{"fullName":...,"headline":...,"currentTitle":...,"currentCompany":...,"location":...,"about":...,"profileUrl":...}}
{"found":true,"ambiguous":true,"candidates":[{"name":...,"distinguishedBy":"one line: company/role/location that tells them apart"}]}
{"found":false}
Use null for unknown fields. profileUrl must be the linkedin.com/in/... URL from the results.`,
      messages: [{ role: "user", content: `Find ${target}. ${instructions}` }],
    });

    const text = response.content
      .filter((b): b is Extract<typeof b, { type: "text" }> => b.type === "text")
      .map((b) => b.text)
      .join("");
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return null;
    const parsed = JSON.parse(match[0]) as SearchLookupResult & {
      profile?: Omit<Profile, "sources">;
    };
    if (!parsed.found) return { found: false };
    if (parsed.ambiguous) {
      return { found: true, ambiguous: true, candidates: parsed.candidates ?? [] };
    }
    if (!parsed.profile) return { found: false };
    return {
      found: true,
      profile: { ...parsed.profile, sources: ["web_search"] } as Profile,
    };
  } catch (err) {
    console.error(`[linkedin] web search lookup failed: ${err instanceof Error ? err.message : err}`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Merge + entry point
// ---------------------------------------------------------------------------

/** Provider fields win; search fills the gaps; both stay in sources. */
function mergeProfiles(provider: Profile, search: Profile | null): Profile {
  if (!search) return provider;
  return {
    fullName: provider.fullName ?? search.fullName,
    headline: provider.headline ?? search.headline,
    currentTitle: provider.currentTitle ?? search.currentTitle,
    currentCompany: provider.currentCompany ?? search.currentCompany,
    location: provider.location ?? search.location,
    about: provider.about ?? search.about,
    experience: provider.experience?.length ? provider.experience : search.experience,
    education: provider.education?.length ? provider.education : search.education,
    profileUrl: provider.profileUrl ?? search.profileUrl,
    sources: [...provider.sources, ...search.sources],
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

    // Path A first; fall through to B when unconfigured, failing, or empty.
    const PROVIDER = currentProvider();
    const provider = await PROVIDER.fetch(cleanInput);
    const providerNote =
      provider.kind === "unavailable"
        ? `The data provider (${PROVIDER.id}) was unavailable: ${provider.detail}`
        : provider.kind === "not-found"
          ? `The person is not in the data provider's (${PROVIDER.id}) database.`
          : null;

    // Path B always runs unless the provider already gave a full profile
    // (then it only fills gaps).
    const search = await webSearchLookup(cleanInput);

    if (search?.ambiguous) {
      return {
        ok: true,
        data: {
          ambiguous: true,
          note: "Several different people match this name. Do NOT pick one - tell the user and list what distinguishes the candidates, then ask which they mean.",
          candidates: search.candidates,
        },
      };
    }

    const searchProfile = search?.found ? (search.profile ?? null) : null;

    // Name lookups: when the provider couldn't resolve by name (e.g. the
    // trial plan gates the resolve endpoint) but search found the profile
    // URL, retry the provider with that URL — URL fetch is the cheaper,
    // more widely available call, and it restores the rich provider data.
    if (provider.kind !== "profile" && !url && searchProfile?.profileUrl) {
      const retry = await PROVIDER.fetch({ url: searchProfile.profileUrl });
      if (retry.kind === "profile") {
        const merged = mergeProfiles(retry.profile, searchProfile);
        return {
          ok: true,
          data: {
            ...merged,
            note: `Data sources: ${merged.sources.join(" + ")} (search located the profile URL; the ${PROVIDER.id} provider supplied the profile data). Name the sources in the answer and cite the profile URL.`,
          },
        };
      }
    }

    if (provider.kind === "profile") {
      const merged = mergeProfiles(provider.profile, searchProfile);
      return {
        ok: true,
        data: {
          ...merged,
          note: `Data sources: ${merged.sources.join(" + ")}. Name the source in the answer (provider data is read from ${PROVIDER.id}; web_search data comes from publicly indexed search results about the profile, not from LinkedIn itself). Cite the profile URL.`,
        },
      };
    }

    if (searchProfile) {
      return {
        ok: true,
        data: {
          ...searchProfile,
          note: `Data source: publicly indexed SEARCH RESULTS about the profile, not LinkedIn itself${providerNote ? ` (${providerNote})` : ""}. Say so plainly and cite the profile URL. Full employment/education history is usually not available via search.`,
        },
      };
    }

    // Neither path found anything — honest failure, never invention.
    return {
      ok: false,
      reason: `No clear match found. ${providerNote ?? ""} Public search also returned nothing usable. Say so and stop - do not invent profile data.`.trim(),
    };
  } catch (err) {
    return {
      ok: false,
      reason: `LinkedIn lookup failed: ${err instanceof Error ? err.message : "unknown error"}`,
    };
  }
}
